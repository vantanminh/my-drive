"""Synology-style Local LAN SSL manager (standard library + openssl CLI only).

Supports two secure local-network HTTPS modes:
1. `letsencrypt_cloudflare`: Issues a real, publicly trusted Let's Encrypt
   certificate via ACME v2 DNS-01 (Cloudflare DNS API) for a LAN hostname whose
   DNS A record points directly to the server's private RFC1918 IPv4 address.
   Every browser and mobile OS trusts the certificate with zero warnings while
   all traffic stays 100% inside the local network.
2. `internal_ca`: Uses Caddy's built-in internal PKI (`tls internal`) for
   completely offline LANs with a downloadable Root CA certificate.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import ipaddress
import json
import os
import re
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import cloudflare

LAN_TLS_MODES = ('off', 'letsencrypt_cloudflare', 'internal_ca')
LETSENCRYPT_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
LETSENCRYPT_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory'
HOST_RE = re.compile(r'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
LOCAL_HOST_RE = re.compile(r'^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$')


class LanTlsError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def validate_lan_tls_config(mode: str, host: str, ip: str, port: int, bind: str = '') -> dict:
    mode = str(mode or 'off').strip().lower()
    if mode not in LAN_TLS_MODES:
        raise LanTlsError('mode must be off, letsencrypt_cloudflare, or internal_ca')
    port = int(port)
    if port != 443 and not (1024 <= port <= 65535):
        raise LanTlsError('LAN HTTPS port must be 443 or between 1024 and 65535')
    bind = str(bind or '').strip()
    if bind:
        try:
            bind = str(ipaddress.IPv4Address(bind))
        except ValueError:
            raise LanTlsError('LAN HTTPS bind address must be a valid IPv4 address') from None

    host = str(host or '').strip().lower().rstrip('.')
    ip = str(ip or '').strip()

    if mode == 'off':
        return {'mode': 'off', 'host': host, 'ip': ip, 'port': port, 'bind': bind}

    if ip:
        try:
            parsed_ip = ipaddress.IPv4Address(ip)
        except ValueError:
            raise LanTlsError('LAN IPv4 address is invalid') from None
        if not (parsed_ip.is_private or parsed_ip.is_loopback or parsed_ip.is_link_local):
            raise LanTlsError('LAN IPv4 address must be a private RFC1918 address (10.x, 172.16-31.x, 192.168.x)')
        ip = str(parsed_ip)

    if mode == 'letsencrypt_cloudflare':
        if not host or not HOST_RE.fullmatch(host):
            raise LanTlsError('LAN SSL domain must be a valid public domain name (e.g. lan.drive.example.com)')
        if not ip:
            raise LanTlsError('LAN IPv4 address is required for Let\'s Encrypt DNS-01 LAN SSL')
    elif mode == 'internal_ca':
        if not host:
            if not ip:
                raise LanTlsError('Provide a LAN IPv4 address or .local hostname for Local CA SSL')
            host = ip
        else:
            is_ip = False
            try:
                ipaddress.IPv4Address(host)
                is_ip = True
            except ValueError:
                pass
            if not is_ip and not LOCAL_HOST_RE.fullmatch(host):
                raise LanTlsError('LAN SSL host must be a valid IPv4 address or hostname')

    return {'mode': mode, 'host': host, 'ip': ip, 'port': port, 'bind': bind}


def _run_openssl(*args: str, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(
        ['openssl', *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        err = (result.stderr or b'').decode('utf-8', errors='replace').strip()
        raise LanTlsError(f'openssl failed ({args[0]}): {err[:300]}')
    return result.stdout


def _der_ecdsa_to_raw(der: bytes, coord_len: int = 32) -> bytes:
    """Convert ASN.1 DER-encoded ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to raw r||s."""
    if len(der) < 8 or der[0] != 0x30:
        raise LanTlsError('invalid DER ECDSA signature')
    idx = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    if der[idx] != 0x02:
        raise LanTlsError('invalid DER ECDSA signature (missing r)')
    r_len = der[idx + 1]
    r_start = idx + 2
    r_bytes = der[r_start:r_start + r_len]
    idx = r_start + r_len
    if der[idx] != 0x02:
        raise LanTlsError('invalid DER ECDSA signature (missing s)')
    s_len = der[idx + 1]
    s_start = idx + 2
    s_bytes = der[s_start:s_start + s_len]
    r_int = int.from_bytes(r_bytes, 'big')
    s_int = int.from_bytes(s_bytes, 'big')
    return r_int.to_bytes(coord_len, 'big') + s_int.to_bytes(coord_len, 'big')


def _ensure_ec_key(path: Path) -> None:
    if path.is_file() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    pem = _run_openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout')
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(pem)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _ec_public_jwk(key_path: Path) -> dict:
    """Extract JWK for an EC P-256 private key using openssl."""
    text = _run_openssl('ec', '-in', str(key_path), '-text', '-noout').decode('ascii', errors='replace')
    match = re.search(r'pub:\s*((?:[0-9a-fA-F]{2}:?\s*)+)', text)
    if not match:
        raise LanTlsError('could not read EC public key coordinates')
    hex_bytes = re.sub(r'[^0-9a-fA-F]', '', match.group(1))
    raw = bytes.fromhex(hex_bytes)
    if len(raw) != 65 or raw[0] != 0x04:
        raise LanTlsError(f'unexpected EC P-256 uncompressed public key length: {len(raw)}')
    x = raw[1:33]
    y = raw[33:65]
    return {'crv': 'P-256', 'kty': 'EC', 'x': b64url(x), 'y': b64url(y)}


def jwk_thumbprint(jwk: dict) -> str:
    canonical = json.dumps(jwk, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return b64url(hashlib.sha256(canonical).digest())


def _sign_es256(key_path: Path, signing_input: bytes) -> str:
    der = _run_openssl('dgst', '-sha256', '-sign', str(key_path), input_bytes=signing_input)
    return b64url(_der_ecdsa_to_raw(der, 32))


def _create_csr_der(domain_key: Path, domain: str) -> bytes:
    with tempfile.NamedTemporaryFile('w', suffix='.cnf', delete=False) as cfg:
        cfg.write(
            '[req]\n'
            'prompt = no\n'
            'distinguished_name = dn\n'
            'req_extensions = san\n'
            '[dn]\n'
            f'CN = {domain}\n'
            '[san]\n'
            f'subjectAltName = DNS:{domain}\n'
        )
        cfg_path = cfg.name
    try:
        return _run_openssl(
            'req', '-new', '-sha256',
            '-key', str(domain_key),
            '-config', cfg_path,
            '-outform', 'DER',
        )
    finally:
        try:
            os.unlink(cfg_path)
        except OSError:
            pass


class AcmeClient:
    """Minimal RFC 8555 ACME v2 client using ES256 and DNS-01."""

    def __init__(self, account_key: Path, directory_url: str = LETSENCRYPT_PRODUCTION_DIRECTORY):
        self.account_key = account_key
        self.directory_url = directory_url
        self.jwk = _ec_public_jwk(account_key)
        self.thumbprint = jwk_thumbprint(self.jwk)
        self.directory = self._get_json(directory_url)
        self.nonce: str | None = None
        self.kid: str | None = None

    def _http(self, method: str, url: str, data: bytes | None = None, headers: dict | None = None):
        req_headers = {'User-Agent': 'my-drive-lan-tls/1.0'}
        if headers:
            req_headers.update(headers)
        req = urllib.request.Request(url, data=data, method=method, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as resp:
                body = resp.read()
                if resp.headers.get('Replay-Nonce'):
                    self.nonce = resp.headers.get('Replay-Nonce')
                return resp.status, dict(resp.headers), body
        except urllib.error.HTTPError as err:
            body = err.read()
            if err.headers and err.headers.get('Replay-Nonce'):
                self.nonce = err.headers.get('Replay-Nonce')
            try:
                detail = json.loads(body or b'{}').get('detail') or err.reason
            except ValueError:
                detail = err.reason
            raise LanTlsError(f'ACME error {err.code}: {detail}') from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise LanTlsError(f'ACME network error: {getattr(err, "reason", err)}') from None

    def _get_json(self, url: str) -> dict:
        _, _, body = self._http('GET', url)
        return json.loads(body.decode('utf-8'))

    def _next_nonce(self) -> str:
        if self.nonce:
            nonce, self.nonce = self.nonce, None
            return nonce
        self._http('HEAD', self.directory['newNonce'])
        if not self.nonce:
            raise LanTlsError('ACME server did not provide a Replay-Nonce')
        nonce, self.nonce = self.nonce, None
        return nonce

    def _post_jws(self, url: str, payload: dict | None, use_kid: bool = True):
        protected: dict = {'alg': 'ES256', 'nonce': self._next_nonce(), 'url': url}
        if use_kid and self.kid:
            protected['kid'] = self.kid
        else:
            protected['jwk'] = self.jwk
        protected_b64 = b64url(json.dumps(protected, separators=(',', ':')).encode('utf-8'))
        payload_b64 = '' if payload is None else b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
        sig_b64 = _sign_es256(self.account_key, f'{protected_b64}.{payload_b64}'.encode('ascii'))
        envelope = json.dumps({
            'protected': protected_b64,
            'payload': payload_b64,
            'signature': sig_b64,
        }).encode('utf-8')
        return self._http('POST', url, data=envelope, headers={'Content-Type': 'application/jose+json'})

    def register(self, email: str | None = None) -> None:
        payload: dict = {'termsOfServiceAgreed': True}
        if email:
            payload['contact'] = [f'mailto:{email}']
        _, headers, _ = self._post_jws(self.directory['newAccount'], payload, use_kid=False)
        loc = headers.get('Location') or headers.get('location')
        if not loc:
            raise LanTlsError('ACME newAccount did not return an account Location')
        self.kid = loc

    def issue_dns01_cloudflare(
        self,
        domain: str,
        cf_token: str,
        domain_key: Path,
        propagation_seconds: int = 15,
        timeout_seconds: int = 180,
    ) -> bytes:
        _, order_headers, order_body = self._post_jws(
            self.directory['newOrder'],
            {'identifiers': [{'type': 'dns', 'value': domain}]},
        )
        order_url = order_headers.get('Location') or order_headers.get('location')
        order = json.loads(order_body.decode('utf-8'))
        authz_urls = order.get('authorizations') or []
        created_records: list[tuple[str, str]] = []
        try:
            challenges_to_trigger = []
            for authz_url in authz_urls:
                _, _, authz_body = self._post_jws(authz_url, None)
                authz = json.loads(authz_body.decode('utf-8'))
                if authz.get('status') == 'valid':
                    continue
                dns01 = next((c for c in authz.get('challenges', []) if c.get('type') == 'dns-01'), None)
                if not dns01:
                    raise LanTlsError(f'ACME server did not offer dns-01 challenge for {domain}')
                key_auth = f"{dns01['token']}.{self.thumbprint}".encode('ascii')
                txt_value = b64url(hashlib.sha256(key_auth).digest())
                record_name = f'_acme-challenge.{domain}'
                zone_id, record_id = cloudflare.create_txt_record(cf_token, record_name, txt_value)
                created_records.append((zone_id, record_id))
                challenges_to_trigger.append((authz_url, dns01['url']))

            if challenges_to_trigger and propagation_seconds > 0:
                time.sleep(propagation_seconds)

            for _, chal_url in challenges_to_trigger:
                self._post_jws(chal_url, {})

            deadline = time.monotonic() + timeout_seconds
            for authz_url, _ in challenges_to_trigger:
                while time.monotonic() < deadline:
                    _, _, authz_body = self._post_jws(authz_url, None)
                    authz = json.loads(authz_body.decode('utf-8'))
                    status = authz.get('status')
                    if status == 'valid':
                        break
                    if status in ('invalid', 'revoked', 'expired'):
                        err_detail = ''
                        for c in authz.get('challenges', []):
                            if c.get('error'):
                                err_detail = c['error'].get('detail') or ''
                                break
                        raise LanTlsError(f'ACME DNS-01 validation failed for {domain}: {err_detail or status}')
                    time.sleep(4)
                else:
                    raise LanTlsError(f'Timed out waiting for ACME DNS-01 validation of {domain}')
        finally:
            for zone_id, record_id in created_records:
                try:
                    cloudflare.delete_dns_record(cf_token, zone_id, record_id)
                except Exception:
                    pass

        _ensure_ec_key(domain_key)
        csr_der = _create_csr_der(domain_key, domain)
        _, _, fin_body = self._post_jws(order['finalize'], {'csr': b64url(csr_der)})
        order = json.loads(fin_body.decode('utf-8'))
        deadline = time.monotonic() + timeout_seconds
        while order.get('status') in ('pending', 'processing') and time.monotonic() < deadline:
            time.sleep(3)
            _, _, poll_body = self._post_jws(order_url, None)
            order = json.loads(poll_body.decode('utf-8'))
        if order.get('status') != 'valid' or not order.get('certificate'):
            raise LanTlsError(f"ACME order finalization failed: status={order.get('status')}")
        _, _, cert_pem = self._post_jws(order['certificate'], None)
        return cert_pem


def issue_letsencrypt_cloudflare(
    cert_dir: Path,
    domain: str,
    cf_token: str,
    email: str | None = None,
    directory_url: str = LETSENCRYPT_PRODUCTION_DIRECTORY,
) -> dict:
    """Issue a Let's Encrypt certificate via Cloudflare DNS-01 and save fullchain.pem + privkey.pem."""
    cert_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
    account_key = cert_dir / 'account.key'
    privkey = cert_dir / 'privkey.pem'
    fullchain = cert_dir / 'fullchain.pem'
    _ensure_ec_key(account_key)
    client = AcmeClient(account_key, directory_url=directory_url)
    client.register(email=email)
    cert_pem = client.issue_dns01_cloudflare(domain, cf_token, privkey)

    tmp = fullchain.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(cert_pem)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, fullchain)
    os.chmod(privkey, 0o600)
    return inspect_certificate(fullchain)


def inspect_certificate(cert_path: Path, renew_threshold_days: int = 30) -> dict:
    """Parse certificate metadata using openssl x509."""
    if not cert_path.is_file():
        return {
            'present': False,
            'valid': False,
            'subject': None,
            'issuer': None,
            'notAfter': None,
            'daysRemaining': None,
            'sans': [],
            'needsRenewal': True,
        }
    try:
        out = _run_openssl(
            'x509', '-in', str(cert_path), '-noout',
            '-subject', '-issuer', '-enddate', '-ext', 'subjectAltName',
        ).decode('utf-8', errors='replace')
    except LanTlsError:
        return {
            'present': True,
            'valid': False,
            'subject': None,
            'issuer': None,
            'notAfter': None,
            'daysRemaining': None,
            'sans': [],
            'needsRenewal': True,
        }

    subject = None
    issuer = None
    not_after_iso = None
    days_remaining = None
    sans: list[str] = []

    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith('subject='):
            subject = stripped[len('subject='):].strip()
        elif stripped.startswith('issuer='):
            issuer = stripped[len('issuer='):].strip()
        elif stripped.startswith('notAfter='):
            raw_date = stripped[len('notAfter='):].strip()
            try:
                dt = datetime.datetime.strptime(raw_date, '%b %d %H:%M:%S %Y %Z').replace(
                    tzinfo=datetime.timezone.utc
                )
                not_after_iso = dt.isoformat()
                days_remaining = int((dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 86400)
            except ValueError:
                not_after_iso = raw_date
        elif 'DNS:' in stripped or 'IP Address:' in stripped:
            for part in stripped.split(','):
                part = part.strip()
                if part.startswith('DNS:'):
                    sans.append(part[4:].strip())
                elif part.startswith('IP Address:'):
                    sans.append(part[11:].strip())

    valid = days_remaining is not None and days_remaining >= 0
    needs_renewal = days_remaining is None or days_remaining < renew_threshold_days
    return {
        'present': True,
        'valid': valid,
        'subject': subject,
        'issuer': issuer,
        'notAfter': not_after_iso,
        'daysRemaining': days_remaining,
        'sans': sans,
        'needsRenewal': needs_renewal,
    }


def needs_renewal(cert_path: Path, threshold_days: int = 30) -> bool:
    info = inspect_certificate(cert_path, renew_threshold_days=threshold_days)
    return bool(info.get('needsRenewal', True))
