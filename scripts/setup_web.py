"""Browser-based first-run wizard for vps.py (standard library only).

By default the wizard listens on every interface but answers only clients on
private networks (home LAN, loopback, link-local), so a computer on the same
router can open http://<server-LAN-IP>:8090 directly. Every visit still needs
the one-time token printed in the terminal. Use --web-listen 127.0.0.1 plus an
SSH tunnel on a VPS or any network you do not trust.
"""
from __future__ import annotations

import hmac
import http.server
import ipaddress
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit

PAGE = Path(__file__).with_name('setup_wizard.html')
MAX_BODY = 64 * 1024
REAL_FS = {'ext4', 'xfs', 'btrfs'}


def list_filesystems():
    """Persistent filesystems that can hold data, largest free space first."""
    try:
        output = subprocess.run(['findmnt', '--json', '--real', '--bytes', '--output',
                                 'TARGET,SOURCE,FSTYPE,SIZE,AVAIL,UUID'], check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    result, seen = [], set()

    def walk(items):
        for item in items:
            walk(item.get('children', []))
            if item.get('fstype') not in REAL_FS or not item.get('uuid') or item['uuid'] in seen:
                continue
            target = item['target']
            if target.startswith(('/boot', '/snap', '/var/lib/docker', '/opt/my-drive')):
                continue
            seen.add(item['uuid'])
            result.append({'mount': target, 'source': item.get('source', ''), 'fstype': item['fstype'],
                           'size': int(item.get('size') or 0), 'avail': int(item.get('avail') or 0),
                           'uuid': item['uuid']})

    walk(json.loads(output).get('filesystems', []))
    return sorted(result, key=lambda fs: -fs['avail'])


def port_free(port):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('0.0.0.0', port))
        except OSError:
            return False
    return True


def memory_gib():
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemTotal:'):
                return round(int(line.split()[1]) / 1024**2, 1)
    except OSError:
        pass
    return 0


def public_ipv4():
    """Best-effort local address used for outbound traffic (no packets are sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('192.0.2.1', 9))
            return sock.getsockname()[0]
    except OSError:
        return ''


def private_client(address):
    """True for loopback, RFC 1918/ULA and link-local peers; never public Internet clients."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_link_local or (ip.is_private and not ip.is_global)


def lan_addresses():
    """Private IPv4 addresses of this machine (what the home router assigned)."""
    try:
        output = subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'], check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    except (OSError, subprocess.CalledProcessError):
        output = ''
    found = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[1].startswith(('docker', 'br-', 'veth', 'virbr', 'cni', 'flannel')):
            continue
        address = parts[3].split('/')[0]
        if private_client(address) and address not in found:
            found.append(address)
    fallback = public_ipv4()
    if not found and fallback and private_client(fallback):
        found.append(fallback)
    return found


class Wizard:
    """Shared state between the HTTP thread and the installer thread."""

    def __init__(self, vps, prebuilt):
        self.vps = vps
        self.prebuilt = prebuilt
        self.token = secrets.token_urlsafe(24)
        self.cookie = secrets.token_urlsafe(32)
        self.submitted = threading.Event()
        self.finished = threading.Event()
        self.config = None
        self.lock = threading.Lock()
        self.status = {'phase': 'setup', 'steps': [], 'error': '', 'url': '', 'password': ''}

    # -- installer side -------------------------------------------------
    def progress(self, message):
        with self.lock:
            if self.status['steps'] and self.status['steps'][-1]['state'] == 'running':
                self.status['steps'][-1]['state'] = 'done'
            self.status['steps'].append({'text': message, 'state': 'running'})

    def done(self, url, password):
        with self.lock:
            for step in self.status['steps']:
                step['state'] = 'done'
            self.status.update(phase='done', url=url, password=password)

    def failed(self, message):
        with self.lock:
            if self.status['steps'] and self.status['steps'][-1]['state'] == 'running':
                self.status['steps'][-1]['state'] = 'failed'
            self.status.update(phase='failed', error=message)

    # -- request side ---------------------------------------------------
    def system(self):
        ports = {str(port): port_free(port) for port in (80, 443)}
        return {'memory_gib': memory_gib(), 'filesystems': list_filesystems(), 'ports': ports,
                'address': public_ipv4(), 'prebuilt': self.prebuilt,
                'docker': bool(shutil.which('docker')),
                'defaults': {'storage': '/srv/my-drive/data', 'database': '/var/lib/my-drive/postgres',
                             'previews': '/var/lib/my-drive/previews', 'quota_gib': 100,
                             'max_file_gib': 5, 'min_free_gib': 5, 'trash_days': 30}}

    def check(self, raw):
        """Validate and run every non-destructive preflight the installer would run."""
        if not isinstance(raw, dict):
            raise ValueError('invalid request')
        config = self.vps.validate(dict(raw, images={}))
        self.vps.preflight(config, self.prebuilt)
        return config

    def cloudflare(self, raw):
        """Read-only check of the API token, zone, account and DNS conflicts."""
        if not isinstance(raw, dict):
            raise ValueError('invalid request')
        cloudflare = self.vps.local_module('cloudflare')
        host = self.vps.valid_host(str(raw.get('host', '')).strip().lower())
        if '.' not in host or host.replace('.', '').isdigit():
            raise ValueError('Cloudflare Tunnel needs a domain name, not an IP address')
        return cloudflare.inspect(cloudflare.valid_token(raw.get('cf_token')), host)

    def submit(self, raw):
        config = self.check(raw)
        with self.lock:
            if self.submitted.is_set():
                raise ValueError('installation already started')
            self.status['phase'] = 'installing'
            self.config = config
            self.submitted.set()


def handler(wizard):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = 'MyDriveSetup'
        sys_version = ''

        def log_message(self, *args):  # never log query strings (they hold the token)
            pass

        def send(self, code, body, kind='application/json', headers=()):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; "
                             "style-src 'unsafe-inline'; img-src data:; connect-src 'self'; "
                             "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            for part in self.headers.get('Cookie', '').split(';'):
                name, _, value = part.strip().partition('=')
                if name == 'mydrive_setup' and hmac.compare_digest(value, wizard.cookie):
                    return True
            return False

        def host_ok(self):
            # Refuse public peers outright, and DNS names in Host (blocks DNS rebinding):
            # the wizard is opened by IP address or localhost only.
            if not private_client(self.client_address[0]):
                return False
            raw = self.headers.get('Host') or ''
            host = raw[1:raw.index(']')] if raw.startswith('[') and ']' in raw else raw.rsplit(':', 1)[0]
            if host == 'localhost':
                return True
            if self.server.loopback:
                return host in {'127.0.0.1', '::1'}
            return private_client(host)

        def do_GET(self):
            if not self.host_ok():
                return self.send(421, {'error': 'open the wizard by the server LAN IP address or localhost, '
                                                'from a computer on the same private network'})
            url = urlsplit(self.path)
            if url.path == '/':
                token = parse_qs(url.query).get('token', [''])[0]
                if token and hmac.compare_digest(token, wizard.token):
                    # Exchange the URL token for an HttpOnly cookie and drop it from history.
                    return self.send(303, b'', 'text/plain', [
                        ('Location', '/'),
                        ('Set-Cookie', f'mydrive_setup={wizard.cookie}; HttpOnly; SameSite=Strict; Path=/')])
                if not self.authorized():
                    return self.send(403, b'Open the full link printed in the server terminal (it contains ?token=...).',
                                     'text/plain; charset=utf-8')
                return self.send(200, PAGE.read_bytes(), 'text/html; charset=utf-8')
            if not self.authorized():
                return self.send(403, {'error': 'forbidden'})
            if url.path == '/api/system':
                return self.send(200, wizard.system())
            if url.path == '/api/status':
                with wizard.lock:
                    return self.send(200, wizard.status)
            return self.send(404, {'error': 'not found'})

        def do_POST(self):
            if not self.host_ok() or not self.authorized():
                return self.send(403, {'error': 'forbidden'})
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.send(415, {'error': 'JSON required'})
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                return self.send(403, {'error': 'cross-origin request refused'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = MAX_BODY + 1
            if length > MAX_BODY:
                return self.send(413, {'error': 'request too large'})
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
                if self.path == '/api/check':
                    wizard.check(body.get('config'))
                    return self.send(200, {'ok': True})
                if self.path == '/api/cloudflare':
                    return self.send(200, dict(wizard.cloudflare(body.get('config')), ok=True))
                if self.path == '/api/install':
                    wizard.submit(body.get('config'))
                    return self.send(202, {'ok': True})
                if self.path == '/api/finish':
                    wizard.finished.set()
                    return self.send(200, {'ok': True})
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                return self.send(400, {'ok': False, 'error': str(error) or 'invalid configuration'})
            except OSError as error:
                return self.send(400, {'ok': False, 'error': f'system check failed: {error.strerror or error}'})
            return self.send(404, {'error': 'not found'})

    return Handler


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def serve(vps, prebuilt, listen='0.0.0.0', port=8090):
    """Start the wizard and return it; the caller waits on wizard.submitted."""
    wizard = Wizard(vps, prebuilt)
    family = socket.AF_INET6 if ':' in listen else socket.AF_INET
    Server.address_family = family
    server = Server((listen, port), handler(wizard))
    server.loopback = listen in {'127.0.0.1', '::1', 'localhost'}
    threading.Thread(target=server.serve_forever, daemon=True).start()
    wizard.server = server
    port = server.server_address[1]
    query = f'/?token={wizard.token}'
    print('\nMy Drive setup wizard is running.')
    if server.loopback:
        print('On THIS machine, open the link below. From your own computer, first create a tunnel:')
        print(f'  ssh -L {port}:127.0.0.1:{port} <user>@<server>')
        print(f'  http://127.0.0.1:{port}{query}')
    else:
        addresses = lan_addresses() if listen in {'0.0.0.0', '::'} else [listen]
        print('From a computer on the SAME home network (Wi-Fi/LAN), open:')
        for address in addresses:
            print(f'  http://{address}:{port}{query}')
        if not addresses:
            print(f'  http://<this-server-LAN-IP>:{port}{query}   (find it with: ip -4 addr)')
        print(f'On this machine: http://127.0.0.1:{port}{query}')
        print('Only private-network clients are answered. The page is plain HTTP inside your LAN;\n'
              'on a VPS or untrusted network use --web-listen 127.0.0.1 with an SSH tunnel instead.')
        if shutil.which('ufw') and 'Status: active' in subprocess.run(
                ['ufw', 'status'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout:
            print(f'UFW is active: allow the wizard temporarily with  sudo ufw allow from 192.168.0.0/16 to any port {port}')
    print('Waiting for the browser (Ctrl+C to cancel)...', flush=True)
    return wizard


def wait_and_close(wizard, timeout=900):
    """Keep the result page reachable until the owner closes it (or timeout)."""
    wizard.finished.wait(timeout)
    time.sleep(0.5)
    wizard.server.shutdown()
