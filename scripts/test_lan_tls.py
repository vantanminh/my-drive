from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lan_tls  # noqa: E402
import vps  # noqa: E402


class LanTlsTests(unittest.TestCase):
    def test_validate_lan_tls_config_enforces_private_ip_and_ports(self):
        spec = lan_tls.validate_lan_tls_config(
            'letsencrypt_cloudflare',
            'LAN.Drive.Example.com.',
            '192.168.1.50',
            443,
            '192.168.1.50',
        )
        self.assertEqual(spec, {
            'mode': 'letsencrypt_cloudflare',
            'host': 'lan.drive.example.com',
            'ip': '192.168.1.50',
            'port': 443,
            'bind': '192.168.1.50',
        })

        # Public IPv4 must be rejected for LAN SSL.
        with self.assertRaises(lan_tls.LanTlsError):
            lan_tls.validate_lan_tls_config('letsencrypt_cloudflare', 'lan.example.com', '8.8.8.8', 443)

        # Privileged ports other than 443 must be rejected.
        with self.assertRaises(lan_tls.LanTlsError):
            lan_tls.validate_lan_tls_config('internal_ca', '192.168.1.50', '192.168.1.50', 80)

        # Internal CA allows IPv4 host directly on custom port.
        ca_spec = lan_tls.validate_lan_tls_config('internal_ca', '', '10.0.0.25', 8443)
        self.assertEqual(ca_spec['host'], '10.0.0.25')
        self.assertEqual(ca_spec['port'], 8443)

    def test_caddyfile_and_compose_configure_lan_ssl_safely(self):
        cfg = {
            'host': 'drive.example.com',
            'tls': 'cloudflare',
            'email': 'owner@example.com',
            'lan_tls_mode': 'letsencrypt_cloudflare',
            'lan_tls_host': 'lan.drive.example.com',
            'lan_tls_ip': '192.168.1.50',
            'lan_tls_port': 443,
            'lan_tls_bind': '',
        }
        caddy = vps.caddyfile(cfg)
        self.assertIn('https://lan.drive.example.com {', caddy)
        self.assertIn('tls /etc/caddy/lan-certs/fullchain.pem /etc/caddy/lan-certs/privkey.pem', caddy)
        self.assertIn('@lan remote_ip private_ranges', caddy)
        self.assertIn('respond "Forbidden (LAN only)" 403', caddy)
        self.assertIn('Strict-Transport-Security', caddy)

        model = {'services': {'proxy': {'ports': ['127.0.0.1:80:80'], 'volumes': []}}}
        vps.ensure_lan_tls_compose(model, cfg)
        self.assertEqual(model['services']['proxy']['ports'], ['127.0.0.1:80:80', '443:443'])
        self.assertTrue(any(v.get('target') == '/etc/caddy/lan-certs' for v in model['services']['proxy']['volumes']))

        # Internal CA in cloudflare mode switches auto_https to disable_redirects so internal PKI works.
        cfg['lan_tls_mode'] = 'internal_ca'
        cfg['lan_tls_host'] = '192.168.1.50'
        cfg['lan_tls_port'] = 8443
        caddy_ca = vps.caddyfile(cfg)
        self.assertIn('auto_https disable_redirects', caddy_ca)
        self.assertIn('https://192.168.1.50:8443 {', caddy_ca)
        self.assertIn('tls internal', caddy_ca)

        vps.ensure_lan_tls_compose(model, cfg)
        self.assertEqual(model['services']['proxy']['ports'], ['127.0.0.1:80:80', '8443:8443'])
        self.assertEqual(model['services']['proxy']['volumes'], [])

        # Turning off restores clean proxy ports.
        cfg['lan_tls_mode'] = 'off'
        vps.ensure_lan_tls_compose(model, cfg)
        self.assertEqual(model['services']['proxy']['ports'], ['127.0.0.1:80:80'])

    def test_ec_key_jwk_signing_csr_and_cert_inspection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            key = root / 'account.key'
            lan_tls._ensure_ec_key(key)
            jwk = lan_tls._ec_public_jwk(key)
            self.assertEqual(jwk['kty'], 'EC')
            self.assertEqual(jwk['crv'], 'P-256')
            thumb = lan_tls.jwk_thumbprint(jwk)
            self.assertGreater(len(thumb), 30)
            sig = lan_tls._sign_es256(key, b'test-payload')
            self.assertGreater(len(sig), 60)

            csr_der = lan_tls._create_csr_der(key, 'lan.drive.example.com')
            self.assertGreater(len(csr_der), 100)

            cert_path = root / 'test.pem'
            subprocess.run(
                [
                    'openssl', 'req', '-x509', '-new', '-key', str(key),
                    '-subj', '/CN=lan.drive.example.com',
                    '-addext', 'subjectAltName=DNS:lan.drive.example.com',
                    '-days', '60', '-out', str(cert_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            info = lan_tls.inspect_certificate(cert_path)
            self.assertTrue(info['present'])
            self.assertTrue(info['valid'])
            self.assertFalse(info['needsRenewal'])
            self.assertIn('lan.drive.example.com', info['sans'])
            self.assertGreaterEqual(info['daysRemaining'], 58)


if __name__ == '__main__':
    unittest.main()
