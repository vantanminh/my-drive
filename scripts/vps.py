#!/usr/bin/env python3
"""Self-owned VPS installation and lifecycle. No third-party Python packages."""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).resolve().parents[1]
INSTALL = Path('/opt/my-drive')
UPDATER_RUN_DIR = Path('/run/my-drive-updater')
UPDATER_SOCKET = UPDATER_RUN_DIR / 'updater.sock'
UPDATER_STATUS_PATH = INSTALL / 'updater-status.json'
NETPLAN_DIR = Path('/etc/netplan')
NETPLAN_MANAGED_FILE = NETPLAN_DIR / '99-my-drive-managed.yaml'
NETPLAN_BACKUP_DIR = INSTALL / 'netplan-backup'
NETPLAN_PENDING_PATH = INSTALL / 'netplan-pending.json'
HOST_BUNDLE_CONTAINER_DIR = '/usr/local/share/my-drive/host-bundle'
ALLOWED_SERVICES = ('app', 'db', 'proxy', 'document-preview', 'media-indexer', 'cloudflared', 'smb')
IFACE_RE = re.compile(r'^[a-zA-Z0-9._-]{1,20}$')
PATH_RE = re.compile(r'/[A-Za-z0-9_./-]+')
CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2026.10.0'
IMAGE_RE = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._:/@-]+')
RELEASE_TAG_RE = re.compile(r'^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')
AGE_RECIPIENT_RE = re.compile(r'^age1[a-z0-9]{10,124}$')
TLS_ALIASES = {'https': 'acme', 'letsencrypt': 'acme', 'self-signed': 'internal',
               'unencrypted': 'http', 'none': 'http', 'plain': 'http',
               'tunnel': 'cloudflare', 'cloudflare-tunnel': 'cloudflare', 'cf': 'cloudflare'}
TLS_MODES = {'acme', 'internal', 'http', 'cloudflare'}
_progress_hook = None


def progress(message):
    print(f'==> {message}', flush=True)
    if _progress_hook:
        _progress_hook(message)


def local_module(name):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    return __import__(name)


def run(*args, capture=False, env=None):
    return subprocess.run([str(a) for a in args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, env=env).stdout


def atomic(path, text, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        os.chmod(name, mode)
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_env(path, values):
    # Double quotes handle backslashes/quotes; $$ disables Compose interpolation.
    lines = []
    for key, value in values.items():
        value = str(value)
        if any(c in value for c in '\r\n\x00'):
            raise ValueError(f'{key} cannot contain newlines or NUL')
        escaped = json.dumps(value, ensure_ascii=False).replace('$', '$$')
        lines.append(f'{key}={escaped}\n')
    atomic(path, ''.join(lines))


def valid_host(host):
    try:
        ipaddress.IPv4Address(host)
        return host
    except ValueError:
        pass
    if len(host) > 253 or '.' not in host or not all(
        re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
        for part in host.split('.')
    ):
        raise ValueError('host must be an IPv4 address or a lowercase DNS name (no URL/path)')
    return host


def valid_path(raw):
    if not isinstance(raw, str) or not PATH_RE.fullmatch(raw):
        raise ValueError('paths must be absolute and contain only letters, digits, /, ., _ and -')
    path = Path(raw)
    if '..' in path.parts or path == Path('/'):
        raise ValueError('unsafe data path')
    # Never chown through symlinks, even when a parent is symlinked.
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise ValueError(f'symlink is not allowed: {parent}')
    return path


def validate(config):
    allowed = {'host', 'tls', 'email', 'owner_password', 'storage', 'database',
               'previews', 'media_indexing', 'images', 'quota_gib', 'max_file_gib',
               'min_free_gib', 'trash_days', 'cf_token', 'cf_replicas',
               'lan_enabled', 'lan_port', 'lan_bind',
               'lan_tls_mode', 'lan_tls_host', 'lan_tls_ip', 'lan_tls_port', 'lan_tls_bind'}
    if set(config) - allowed:
        raise ValueError(f'unknown configuration fields: {sorted(set(config) - allowed)}')
    result = dict(config)
    result['host'] = valid_host(str(config.get('host', '')).strip().lower())
    if isinstance(config.get('tls'), str):
        result['tls'] = TLS_ALIASES.get(config['tls'].strip().lower(), config['tls'].strip().lower())
    if result.get('tls', 'acme') not in TLS_MODES:
        raise ValueError('tls must be acme, internal, http, or cloudflare')
    result.setdefault('tls', 'acme')
    result.pop('cf_token', None)
    result.pop('cf_replicas', None)
    if result['tls'] == 'cloudflare':
        replicas = config.get('cf_replicas', 2)
        if type(replicas) is not int or not 1 <= replicas <= 8:
            raise ValueError('cf_replicas must be an integer from 1 to 8')
        result['cf_replicas'] = replicas
        if config.get('cf_token'):
            token = str(config['cf_token']).strip()
            if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', token):
                raise ValueError('Cloudflare API token looks invalid')
            result['cf_token'] = token
    lan_enabled = config.get('lan_enabled')
    if lan_enabled is None:
        lan_enabled = result['tls'] == 'cloudflare'
    elif not isinstance(lan_enabled, bool):
        raise ValueError('lan_enabled must be a boolean')
    result['lan_enabled'] = lan_enabled
    lan_port = config.get('lan_port', 3000)
    if type(lan_port) is not int or not 1 <= lan_port <= 65535:
        raise ValueError('lan_port must be an integer from 1 to 65535')
    result['lan_port'] = lan_port
    lan_bind = config.get('lan_bind')
    if lan_bind is not None and lan_bind != '':
        try:
            ip = ipaddress.IPv4Address(str(lan_bind).strip())
        except ValueError:
            raise ValueError('lan_bind must be a valid IPv4 address') from None
        result['lan_bind'] = str(ip)
    else:
        result.pop('lan_bind', None)
    if result['tls'] in ('acme', 'cloudflare'):
        try:
            ipaddress.IPv4Address(result['host'])
        except ValueError:
            pass
        else:
            raise ValueError('ACME and Cloudflare Tunnel need a domain name; use internal TLS for an IP')
    result['email'] = str(config.get('email', '')).strip()
    if not re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', result['email']):
        raise ValueError('a valid owner email is required')
    password = config.get('owner_password') or secrets.token_urlsafe(32)
    if not isinstance(password, str) or len(password.encode()) < 16 or any(c in password for c in '\r\n\x00'):
        raise ValueError('owner_password must be at least 16 bytes, without newlines or NUL')
    result['owner_password'] = password
    result.setdefault('media_indexing', False)
    if not isinstance(result['media_indexing'], bool):
        raise ValueError('media_indexing must be a boolean')
    paths = []
    for field, default in [('storage', '/srv/my-drive/data'), ('database', '/var/lib/my-drive/postgres'),
                           ('previews', '/var/lib/my-drive/previews')]:
        path = valid_path(config.get(field, default))
        if path == INSTALL or INSTALL in path.parents or path in INSTALL.parents:
            raise ValueError('data paths must be outside the installation directory')
        for previous in paths:
            if path == previous or path in previous.parents or previous in path.parents:
                raise ValueError('data directories must not overlap')
        paths.append(path)
        result[field] = str(path)
    for field, default in [('quota_gib', 100), ('max_file_gib', 5), ('min_free_gib', 5), ('trash_days', 30)]:
        value = config.get(field, default)
        if type(value) is not int or value < 1 or value > 1048576:
            raise ValueError(f'{field} must be a positive integer <= 1048576')
        result[field] = value
    images = config.get('images', {})
    needed = {'app', 'document-preview'} | ({'media-indexer'} if result['media_indexing'] else set())
    if not isinstance(images, dict) or (images and set(images) != needed):
        raise ValueError(f'images must be empty (local build), or define exactly {sorted(needed)}')
    if any(not isinstance(image, str) or not IMAGE_RE.fullmatch(image) for image in images.values()):
        raise ValueError('invalid image reference')
    result['images'] = images
    return result


def ask(prebuilt=False):
    print('My Drive Ubuntu VPS setup. Configuration stays on this server.')
    host = input('Domain or IPv4 address: ').strip().lower()
    tls = input('Access: acme HTTPS / internal HTTPS / http only (unencrypted) [acme]: ').strip().lower() or 'acme'
    tls = TLS_ALIASES.get(tls, tls)
    if tls == 'http':
        print('HTTP does not encrypt traffic. Use only on a trusted network or through a secure tunnel.')
    email = input('Owner email (also ACME contact when enabled): ').strip()
    password = getpass.getpass('Owner password (>=16 bytes; empty = generate): ')
    if password and getpass.getpass('Repeat password: ') != password:
        raise ValueError('passwords do not match')
    config = {'host': host, 'tls': tls, 'email': email, 'owner_password': password}
    for field, default in [('storage', '/srv/my-drive/data'), ('database', '/var/lib/my-drive/postgres'),
                           ('previews', '/var/lib/my-drive/previews')]:
        config[field] = input(f'{field} directory [{default}]: ').strip() or default
    config['media_indexing'] = input('Enable image/video/face indexing on a separate preview filesystem? [y/N]: ').lower() == 'y'
    for field, default in [('quota_gib', 100), ('max_file_gib', 5), ('min_free_gib', 5), ('trash_days', 30)]:
        config[field] = int(input(f'{field} [{default}]: ') or default)
    print('CI-published images will be downloaded; nothing is built on this VPS.' if prebuilt else
          'Images will be built from this checkout. Use --config for your own registry images.')
    return validate(config)


def prebuilt_images(config, prefix, tag):
    if '://' in prefix or not re.fullmatch(r'[a-z0-9][a-z0-9._:/-]+', prefix) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag):
        raise ValueError('invalid prebuilt image prefix or tag')
    images = {'app': f'{prefix}:{tag}', 'document-preview': f'{prefix}-document-preview:{tag}'}
    if config['media_indexing']:
        images['media-indexer'] = f'{prefix}-indexer:{tag}'
    return images


def filesystem(path):
    item = json.loads(run('findmnt', '--json', '--target', path, '--output', 'UUID,MAJ:MIN,FSTYPE,TARGET', capture=True))['filesystems'][0]
    if not item.get('uuid') or item['fstype'] not in {'ext4', 'xfs', 'btrfs'}:
        raise ValueError(f'{path}: persistent ext4/xfs/btrfs filesystem with UUID required')
    return {'uuid': item['uuid'], 'device': item['maj:min'], 'mount': item['target']}


def inspect_targets(config):
    """Validate data targets without creating or changing anything."""
    for field in ('storage', 'database', 'previews'):
        path = valid_path(config[field])
        if path.exists() and (not path.is_dir() or any(path.iterdir())):
            raise ValueError(f'new installation requires an empty directory: {path}')
    mounts = {}
    for field in ('storage', 'database', 'previews'):
        path = Path(config[field])
        existing = next(parent for parent in [path, *path.parents] if parent.exists())
        mounts[field] = filesystem(existing)
    if config['media_indexing'] and mounts['storage']['uuid'] == mounts['previews']['uuid']:
        raise ValueError('media indexing needs different storage and preview filesystems')
    return mounts


def preflight(config, prebuilt):
    """Every non-destructive host check the installer needs before writing files."""
    if (INSTALL / 'state.json').exists() or (INSTALL.exists() and any(INSTALL.iterdir())):
        raise ValueError(f'{INSTALL} already contains an installation')
    memory_kib = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                          if line.startswith('MemTotal:')))
    minimum = 2 if (config['images'] or prebuilt) else 4
    if memory_kib < minimum * 1024**2 * 0.95:
        raise ValueError(f'at least {minimum} GiB RAM required for this installation mode')
    address = '127.0.0.1' if config['tls'] == 'cloudflare' else '0.0.0.0'
    for port in (80,) if config['tls'] in ('http', 'cloudflare') else (80, 443):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((address, port))
            except OSError:
                raise ValueError(f'TCP port {port} is already in use; stop the other web server first') from None
    return inspect_targets(config)


def prepare(config):
    # Validate all targets before creating or changing any data directory.
    mounts = inspect_targets(config)
    for field in ('storage', 'database', 'previews'):
        path = Path(config[field])
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path, 0o700)
        if field != 'database':
            os.chown(path, 10001, 10001)
    return mounts


def compose(*args, capture=False):
    return run('docker', 'compose', '--project-directory', INSTALL, '--env-file', INSTALL / '.env',
               '-f', INSTALL / 'compose.yaml', '-p', 'my-drive', *args, capture=capture,
               env=compose_environment())


def compose_environment():
    # Shell variables override --env-file in Compose; do not accept accidental overrides.
    env = dict(os.environ)
    model = (INSTALL / 'compose.yaml').read_text()
    for key in re.findall(r'\$\{([A-Za-z_][A-Za-z_0-9]*)', model):
        env.pop(key, None)
    for key in ('COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES'):
        env.pop(key, None)
    return env


def make_compose(model, config):
    services = model['services']
    if not config['media_indexing']:
        services.pop('media-indexer', None)
        services.pop('media-indexer-db-setup', None)
        env = services['app']['environment']
        for key in list(env):
            if key.startswith('MEDIA_PREVIEW_'):
                del env[key]
        # Keep the unused, empty preview bind for compatibility with backup/restore.
    services['app']['ports'] = []  # Only the reverse proxy is published by default.
    ensure_lan_compose(model, config)
    services['app']['environment']['COOKIE_SECURE'] = 'false' if config['tls'] == 'http' else 'true'
    for service in services.values():
        service['logging'] = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}
    if config['tls'] == 'cloudflare':
        proxy_ports = ['127.0.0.1:80:80']  # Only the local tunnel connector reaches the proxy.
    else:
        proxy_ports = ['80:80']
    if config['tls'] not in ('http', 'cloudflare'):
        proxy_ports.append('443:443')
    services['proxy'] = {
        'image': 'caddy:2-alpine', 'restart': 'unless-stopped',
        'ports': proxy_ports,
        'volumes': [{'type': 'bind', 'source': str(INSTALL / 'Caddyfile'), 'target': '/etc/caddy/Caddyfile',
                     'read_only': True, 'bind': {'create_host_path': False}},
                    {'type': 'bind', 'source': str(INSTALL / 'caddy-data'), 'target': '/data',
                     'bind': {'create_host_path': False}},
                    {'type': 'bind', 'source': str(INSTALL / 'caddy-config'), 'target': '/config',
                     'bind': {'create_host_path': False}}],
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }
    if config['tls'] == 'cloudflare':
        services['cloudflared'] = cloudflared_service(config.get('cf_replicas', 2))
    ensure_lan_tls_compose(model, config)
    ensure_updater_compose(model)
    return model


def ensure_updater_runtime_dir():
    UPDATER_RUN_DIR.mkdir(parents=True, exist_ok=True, mode=0o750)
    os.chmod(UPDATER_RUN_DIR, 0o750)
    os.chown(UPDATER_RUN_DIR, 0, 10001)


def ensure_lan_compose(model, config, force=False):
    app = model['services']['app']
    existing = list(app.get('ports') or [])
    if 'lan_enabled' in config:
        enabled = bool(config['lan_enabled'])
    else:
        enabled = config.get('tls') == 'cloudflare'
    port = int(config.get('lan_port', 3000) or 3000)
    bind_ip = str(config.get('lan_bind') or '').strip()
    mapping = f'{bind_ip}:{port}:3000' if bind_ip else f'{port}:3000'
    if enabled:
        if force:
            app['ports'] = [mapping]
        elif not existing:
            app['ports'] = [mapping]
    elif force:
        app['ports'] = []
    return model


def ensure_lan_tls_compose(model, config):
    """Configure Caddy proxy ports and lan-certs bind mount for Local LAN SSL."""
    proxy = model['services'].get('proxy')
    if not isinstance(proxy, dict):
        return model
    tls_mode = config.get('tls', 'acme')
    if tls_mode == 'cloudflare':
        ports = ['127.0.0.1:80:80']
    else:
        ports = ['80:80']
    if tls_mode not in ('http', 'cloudflare'):
        ports.append('443:443')

    lan_tls_mode = str(config.get('lan_tls_mode') or 'off').strip().lower()
    if lan_tls_mode in ('letsencrypt_cloudflare', 'internal_ca'):
        default_port = 443 if tls_mode == 'cloudflare' else 8443
        lan_port = int(config.get('lan_tls_port') or default_port)
        bind_ip = str(config.get('lan_tls_bind') or '').strip()
        mapping = f'{bind_ip}:{lan_port}:{lan_port}' if bind_ip else f'{lan_port}:{lan_port}'
        if mapping not in ports and not (not bind_ip and lan_port == 443 and '443:443' in ports):
            ports.append(mapping)
    proxy['ports'] = ports

    volumes = proxy.setdefault('volumes', [])
    target = '/etc/caddy/lan-certs'
    if lan_tls_mode == 'letsencrypt_cloudflare':
        if not any(isinstance(v, dict) and v.get('target') == target for v in volumes):
            volumes.append({
                'type': 'bind',
                'source': str(INSTALL / 'lan-certs'),
                'target': target,
                'read_only': True,
                'bind': {'create_host_path': False},
            })
    else:
        proxy['volumes'] = [v for v in volumes if not (isinstance(v, dict) and v.get('target') == target)]
    return model


def ensure_updater_compose(model):
    app = model['services']['app']
    env = app.setdefault('environment', {})
    env.setdefault('MY_DRIVE_UPDATER_SOCKET', '/run/my-drive-updater/updater.sock')
    env.setdefault('MY_DRIVE_IMAGE', '${MY_DRIVE_IMAGE:-ghcr.io/vantanminh/my-drive:latest}')
    volumes = app.setdefault('volumes', [])
    target = '/run/my-drive-updater'
    if not any(isinstance(v, dict) and v.get('target') == target for v in volumes):
        volumes.append({
            'type': 'bind',
            'source': UPDATER_RUN_DIR.as_posix(),
            'target': target,
            'bind': {'create_host_path': False},
        })
    return model


def cloudflared_service(replicas):
    # Several connector replicas of one tunnel: each holds 4 edge connections,
    # so N replicas give 4*N connections across Cloudflare data centers.
    return {
        'image': CLOUDFLARED_IMAGE, 'restart': 'unless-stopped',
        'command': ['tunnel', '--no-autoupdate', '--protocol', 'auto', 'run'],
        'environment': {'TUNNEL_TOKEN': '${CLOUDFLARE_TUNNEL_TOKEN:?Cloudflare tunnel token missing}'},
        'deploy': {'replicas': replicas}, 'depends_on': ['proxy'], 'read_only': True,
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'mem_limit': '256m', 'pids_limit': 64,
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }


def _lan_tls_caddy_block(config):
    mode = str(config.get('lan_tls_mode') or 'off').strip().lower()
    if mode not in ('letsencrypt_cloudflare', 'internal_ca'):
        return ''
    host = str(config.get('lan_tls_host') or '').strip()
    if not host:
        return ''
    default_port = 443 if config.get('tls') == 'cloudflare' else 8443
    port = int(config.get('lan_tls_port') or default_port)
    addr = f'https://{host}' if port == 443 else f'https://{host}:{port}'
    if mode == 'letsencrypt_cloudflare':
        tls_line = '    tls /etc/caddy/lan-certs/fullchain.pem /etc/caddy/lan-certs/privkey.pem\n'
    else:
        tls_line = '    tls internal\n'
    return (
        f'\n{addr} {{\n'
        + tls_line
        + '    @lan remote_ip private_ranges\n'
        + '    handle @lan {\n'
        + '        reverse_proxy app:3000\n'
        + '        header X-Content-Type-Options nosniff\n'
        + '        header Strict-Transport-Security "max-age=31536000; includeSubDomains"\n'
        + '    }\n'
        + '    handle {\n'
        + '        respond "Forbidden (LAN only)" 403\n'
        + '    }\n'
        + '}\n'
    )


def caddyfile(config):
    lan_block = _lan_tls_caddy_block(config)
    lan_mode = str(config.get('lan_tls_mode') or 'off').strip().lower()
    if config['tls'] == 'cloudflare':
        # TLS ends at Cloudflare's edge; the tunnel reaches Caddy over the private Docker network.
        # Keep internal PKI active when Local CA LAN SSL is enabled.
        auto_https = '    auto_https disable_redirects\n' if lan_mode == 'internal_ca' else '    auto_https off\n'
        return (
            '{\n    admin off\n' + auto_https + '}\n'
            + f"http://{config['host']} {{\n"
            + '''    reverse_proxy app:3000
    header X-Content-Type-Options nosniff
}
'''
            + lan_block
        )
    global_options = '{\n    admin off\n' + (f"    email {config['email']}\n" if config['tls'] == 'acme' else '') + '}\n'
    tls = '    tls internal\n' if config['tls'] == 'internal' else ''
    scheme = 'http' if config['tls'] == 'http' else 'https'
    return global_options + f"{scheme}://{config['host']} {{\n" + tls + '''    reverse_proxy app:3000
    header X-Content-Type-Options nosniff
}
''' + lan_block


def build_images(config, source):
    if config['images']:
        images = {}
        for image in config['images'].values():
            run('docker', 'pull', image)
        for service, image in config['images'].items():
            # Keep the exact pulled artifact even when the remote tag moves later.
            images[service] = run('docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', image, capture=True).strip()
            if not images[service] or not IMAGE_RE.fullmatch(images[service]):
                raise ValueError('pulled image has no usable registry digest')
        return images
    tag = secrets.token_hex(6)
    targets = {'app': 'runtime', 'document-preview': 'document-preview-runtime'}
    if config['media_indexing']:
        targets['media-indexer'] = 'media-indexer-runtime'
    images = {}
    for service, target in targets.items():
        image = f'my-drive-local-{service}:{tag}'
        run('docker', 'build', '--target', target, '--tag', image, source)
        images[service] = image
    return images


def check(state):
    mounts = {}
    for field, expected in state['mounts'].items():
        path = valid_path(state['config'][field])
        if not path.is_dir():
            raise ValueError(f'data directory missing: {path}')
        actual = filesystem(path)
        if actual['uuid'] != expected['uuid'] or actual['mount'] != expected['mount']:
            raise ValueError(f'{path}: configured filesystem is missing or replaced; refusing startup')
        mounts[field] = actual
    # Linux major:minor numbers may change after reboot; UUID remains authoritative.
    values = state['env']
    values['STORAGE_EXPECTED_DEVICE'] = mounts['storage']['device']
    values['MEDIA_PREVIEW_EXPECTED_DEVICE'] = mounts['previews']['device']
    write_env(INSTALL / '.env', values)


def wait_ready():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = subprocess.run(['docker', 'compose', '--project-directory', str(INSTALL),
                                 '--env-file', str(INSTALL / '.env'), '-f', str(INSTALL / 'compose.yaml'),
                                 '-p', 'my-drive', 'exec', '-T', 'app', 'curl', '--fail', '--silent',
                                'http://127.0.0.1:3000/health/ready'], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=compose_environment())
        if result.returncode == 0:
            return
        time.sleep(3)
    raise ValueError('app did not become ready; run my-drive logs app. No credentials were removed.')


def save(state):
    atomic(INSTALL / 'state.json', json.dumps(state, indent=2) + '\n')


def start(state):
    if getattr(os, 'geteuid', lambda: -1)() == 0:
        ensure_updater_runtime_dir()
    check(state)
    # Bootstrap privately before opening the public proxy.
    compose('up', '-d', 'app')
    wait_ready()
    if state['env'].get('BOOTSTRAP_OWNER_PASSWORD'):
        state['env']['BOOTSTRAP_OWNER_EMAIL'] = ''
        state['env']['BOOTSTRAP_OWNER_PASSWORD'] = ''
        save(state)
        write_env(INSTALL / '.env', state['env'])
        compose('up', '-d', '--force-recreate', 'app')
        wait_ready()
    compose('up', '-d')
    if state['config']['media_indexing']:
        setup_id = compose('ps', '--all', '-q', 'media-indexer-db-setup', capture=True).strip()
        if not setup_id or run('docker', 'wait', setup_id, capture=True).strip() != '0':
            raise ValueError('indexer role setup failed; run my-drive logs media-indexer-db-setup')
        indexer_id = compose('ps', '-q', 'media-indexer', capture=True).strip()
        if not indexer_id or run('docker', 'inspect', '-f', '{{.State.Running}}', indexer_id, capture=True).strip() != 'true':
            raise ValueError('media indexer is not running')
    # Validate readiness through the actual proxy, including TLS identity when enabled.
    args = ['curl', '--fail', '--silent', '--show-error', '--retry', '12', '--retry-delay', '5',
            '--retry-all-errors', '--max-time', '10']
    if state['config']['tls'] == 'internal':
        root = INSTALL / 'caddy-data/caddy/pki/authorities/local/root.crt'
        for _ in range(30):
            if root.exists():
                break
            time.sleep(1)
        args += ['--cacert', str(root)]
    scheme = 'http' if state['config']['tls'] in ('http', 'cloudflare') else 'https'
    port = 80 if scheme == 'http' else 443
    args += ['--resolve', f"{state['config']['host']}:{port}:127.0.0.1"]
    run(*args, f"{scheme}://{state['config']['host']}/health/ready")


def install_updater_service(prepare_only=False, restart=True):
    ensure_updater_runtime_dir()
    atomic('/etc/systemd/system/my-drive-updater.service', '''[Unit]
Description=My Drive host update agent
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/my-drive updater-serve
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
''', 0o644)
    run('systemctl', 'daemon-reload')
    if not prepare_only:
        run('systemctl', 'enable', 'my-drive-updater.service')
        if restart:
            run('systemctl', 'restart', 'my-drive-updater.service')


def install(args):
    if (INSTALL / 'state.json').exists():
        print('Existing installation: resume with saved settings; no passwords or data are reset.')
        state = json.loads((INSTALL / 'state.json').read_text())
        if args.config:
            raise ValueError('existing installation: omit --config to resume; configuration is not overwritten')
    else:
        if INSTALL.exists() and any(INSTALL.iterdir()):
            raise ValueError(f'{INSTALL} is nonempty without installer state; refusing to overwrite')
        if args.config:
            config = validate(json.loads(Path(args.config).read_text()))
        elif getattr(args, 'wizard', None):
            args.wizard.submitted.wait()
            config = dict(args.wizard.config)  # the wizard keeps its copy to show the password
        else:
            config = ask(args.prebuilt)
        if args.prebuilt:
            if not config['images']:
                config['images'] = prebuilt_images(config, args.image_prefix, args.image_tag)
            config = validate(config)
        progress('Checking memory, ports and data disks')
        preflight(config, args.prebuilt)
        tunnel = None
        if config['tls'] == 'cloudflare':
            if not config.get('cf_token'):
                raise ValueError('Cloudflare Tunnel mode needs cf_token (an API token) during installation')
            cloudflare = local_module('cloudflare')
            progress('Creating Cloudflare Tunnel and routing the DNS record')
            tunnel = cloudflare.provision(config['cf_token'], config['host'])
        progress('Creating data directories')
        mounts = prepare(config)
        INSTALL.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(INSTALL, 0o700)
        progress('Downloading container images' if config['images'] else 'Building container images (this can take a while)')
        images = build_images(config, SOURCE)
        progress('Writing private configuration and secrets')
        values = {
            'POSTGRES_PASSWORD': secrets.token_hex(32), 'MEDIA_INDEXER_PASSWORD': secrets.token_hex(32),
            'POSTGRES_DATA_SSD': config['database'], 'STORAGE_DATA_HDD': config['storage'],
            'MEDIA_PREVIEW_DATA_SSD': config['previews'], 'STORAGE_EXPECTED_DEVICE': mounts['storage']['device'],
            'MEDIA_PREVIEW_EXPECTED_DEVICE': mounts['previews']['device'], 'MY_DRIVE_IMAGE': images['app'],
            'MY_DRIVE_DOCUMENT_PREVIEW_IMAGE': images['document-preview'],
            'MY_DRIVE_INDEXER_IMAGE': images.get('media-indexer', 'unused-local-indexer:disabled'),
            'BOOTSTRAP_OWNER_EMAIL': config['email'], 'BOOTSTRAP_OWNER_PASSWORD': config['owner_password'],
            'OWNER_QUOTA_BYTES': config['quota_gib'] * 1024**3,
            'MAX_FILE_SIZE': config['max_file_gib'] * 1024**3,
            'MIN_FREE_BYTES': config['min_free_gib'] * 1024**3, 'TRASH_RETENTION_DAYS': config['trash_days'],
        }
        if tunnel:
            values['CLOUDFLARE_TUNNEL_TOKEN'] = tunnel.pop('connector_token')
        write_env(INSTALL / '.env', values)
        scheme = 'http' if config['tls'] == 'http' else 'https'
        atomic(INSTALL / 'owner-credentials.txt', f"URL: {scheme}://{config['host']}\nEmail: {config['email']}\nPassword: {config['owner_password']}\n")
        del config['owner_password']
        config.pop('cf_token', None)  # The API token is never stored; only the connector token is.
        state = {'config': config, 'mounts': mounts, 'env': values}
        if tunnel:
            state['cloudflare'] = tunnel
        save(state)
    progress('Generating service and reverse-proxy configuration')
    if not (INSTALL / 'compose.yaml').exists():
        model = json.loads(run('docker', 'compose', '--env-file', INSTALL / '.env', '-f', SOURCE / 'compose.yaml',
                               'config', '--no-interpolate', '--no-path-resolution', '--format', 'json', capture=True))
        model = make_compose(model, state['config'])
        atomic(INSTALL / 'compose.yaml', json.dumps(model, indent=2) + '\n')
    atomic(INSTALL / 'Caddyfile', caddyfile(state['config']))
    # Runtime files are copied so deleting the source checkout does not break operations.
    if SOURCE != INSTALL:
        for directory in ('scripts', 'docker'):
            shutil.copytree(SOURCE / directory, INSTALL / directory, dirs_exist_ok=True)
    for script in (INSTALL / 'scripts').glob('*.sh'):
        script.chmod(0o700)
    # docker compose config expands relative bind sources to the checkout: relocate role setup.
    model = json.loads((INSTALL / 'compose.yaml').read_text())
    if 'media-indexer-db-setup' in model['services']:
        model['services']['media-indexer-db-setup']['volumes'][0]['source'] = str(INSTALL / 'docker/setup-indexer-role.sh')
        atomic(INSTALL / 'compose.yaml', json.dumps(model, indent=2) + '\n')
    for directory in ('caddy-data', 'caddy-config'):
        (INSTALL / directory).mkdir(exist_ok=True, mode=0o700)
    compose('config', '--quiet')
    atomic('/usr/local/bin/my-drive', '#!/bin/sh\nexec python3 /opt/my-drive/scripts/vps.py "$@"\n', 0o755)
    mounts = ' '.join(state['config'][field] for field in ('storage', 'database', 'previews'))
    atomic('/etc/systemd/system/my-drive.service', f'''[Unit]
Description=My Drive private cloud
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor={mounts}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/my-drive start
ExecStop=/usr/local/bin/my-drive stop
TimeoutStartSec=600
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
''', 0o644)
    # Gate automatic reboot startup through UUID verification (not Docker restart alone).
    model = json.loads((INSTALL / 'compose.yaml').read_text())
    for service in model['services'].values():
        if service.get('restart') == 'unless-stopped':
            service['restart'] = 'on-failure:5'
    atomic(INSTALL / 'compose.yaml', json.dumps(model, indent=2) + '\n')
    run('systemctl', 'daemon-reload')
    install_updater_service(prepare_only=args.prepare_only, restart=not args.prepare_only)
    if not args.prepare_only:
        run('systemctl', 'enable', 'my-drive.service')
    return state


def verify_tunnel(state, token):
    """Confirm every connector replica registered, then reach the app through Cloudflare."""
    import urllib.request
    cloudflare = local_module('cloudflare')
    info = state['cloudflare']
    progress(f"Verifying {state['config']['cf_replicas']} tunnel connector(s) with Cloudflare")
    result = cloudflare.wait_connected(token, info['account_id'], info['tunnel_id'], state['config']['cf_replicas'])
    progress(f"Tunnel online: {result['connections']} connections via {', '.join(result['colos']) or 'Cloudflare'}; "
             'checking the public address')
    url = f"https://{state['config']['host']}/health/ready"
    for _ in range(24):
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(5)
    progress('Tunnel is connected, but the public address is not answering yet (DNS may still be propagating)')


def backup(state, args):
    check(state)
    env = dict(compose_environment(), APP_ENV_FILE=str(INSTALL / '.env'), COMPOSE_FILE_PATH=str(INSTALL / 'compose.yaml'),
               COMPOSE_PROJECT_NAME='my-drive', BACKUP_ROOT=args.backup_root, AGE_RECIPIENT=args.recipient)
    output = run('bash', INSTALL / 'scripts/backup.sh', env=env, capture=True)
    print(output, end='')
    bundle = Path(next(line.split(': ', 1)[1] for line in output.splitlines()
                       if line.startswith('encrypted backup created: ')))
    # The existing strict bundle format remains unchanged. Installer state and TLS
    # private keys travel as an encrypted companion next to the validated bundle.
    companion = bundle.parent / (bundle.name + '.deployment.tar.age')
    tar = subprocess.Popen(['tar', '--numeric-owner', '-cf', '-', '-C', str(INSTALL),
                            'state.json', 'compose.yaml', '.env', 'Caddyfile', 'scripts', 'docker',
                            'caddy-data', 'caddy-config'], stdout=subprocess.PIPE)
    try:
        age = subprocess.run(['age', '--recipient', args.recipient, '--output', str(companion)],
                             stdin=tar.stdout, check=False)
        tar.stdout.close()
        if age.returncode or tar.wait():
            companion.unlink(missing_ok=True)
            raise ValueError('application backup exists, but encrypted deployment companion failed; update aborted')
    finally:
        if tar.poll() is None:
            tar.terminate()
            tar.wait()
    print(f'Encrypted deployment configuration and TLS keys: {companion}')


def update_backup_options(state, args):
    """Resolve one-time backup settings for the no-argument update command."""
    saved = state.get('update_backup', {})
    if not isinstance(saved, dict):
        raise ValueError('saved update backup settings are invalid')
    root = args.backup_root or saved.get('root')
    recipient = args.recipient or saved.get('recipient')
    if not root or not recipient:
        if getattr(args, 'non_interactive', False) or not sys.stdin.isatty():
            raise ValueError('first update needs --backup-root and --recipient, or an interactive terminal')
        print('Updates require an encrypted backup on a separate filesystem.')
        if not root:
            root = input('Backup destination (for example /mnt/backup/my-drive): ').strip()
        if not recipient:
            recipient = input('Age public recipient (age1...): ').strip()
    return validate_backup_settings(root, recipient)


def validate_backup_settings(root, recipient):
    from pathlib import PurePosixPath
    if not root or not recipient:
        raise ValueError('backup destination and age public recipient are required')
    if not isinstance(root, str) or any(char in root for char in '\r\n\x00') or not root.strip().startswith('/') or root.strip() == '/':
        raise ValueError('backup destination must be an absolute path without control characters')
    root = root.strip()
    if '..' in PurePosixPath(root).parts:
        raise ValueError('backup destination cannot contain parent traversal segments')
    if not isinstance(recipient, str) or not AGE_RECIPIENT_RE.fullmatch(recipient.strip()):
        raise ValueError('age public recipient must be a valid age1 public key')
    return argparse.Namespace(backup_root=root, recipient=recipient.strip())


def apply_release_tag(images, tag):
    if not RELEASE_TAG_RE.fullmatch(tag):
        raise ValueError('release tag must start with v and use semantic versioning (for example v0.1.2)')
    updated = {}
    for service, ref in images.items():
        if not isinstance(ref, str) or '@sha256:' in ref:
            raise ValueError(f'cannot override tag on pinned digest reference for {service}')
        base = ref.rsplit(':', 1)[0] if ':' in ref.rsplit('/', 1)[-1] else ref
        updated[service] = f'{base}:{tag}'
    return updated


def read_updater_status():
    if UPDATER_STATUS_PATH.is_file():
        try:
            data = json.loads(UPDATER_STATUS_PATH.read_text())
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return {
        'status': 'idle',
        'phase': None,
        'message': None,
        'targetTag': None,
        'startedAt': None,
        'finishedAt': None,
        'updatedAt': None,
    }


def write_updater_status(payload):
    from datetime import datetime, timezone
    data = dict(payload)
    data['updatedAt'] = datetime.now(timezone.utc).isoformat()
    atomic(UPDATER_STATUS_PATH, json.dumps(data, indent=2) + '\n')
    return data


def _updater_status_payload(state):
    status_data = read_updater_status()
    images = state.get('config', {}).get('images', {}) if isinstance(state, dict) else {}
    return {
        'connected': True,
        'status': status_data.get('status', 'idle'),
        'phase': status_data.get('phase'),
        'message': status_data.get('message'),
        'targetTag': status_data.get('targetTag'),
        'imageTrack': images.get('app') if isinstance(images, dict) else None,
        'startedAt': status_data.get('startedAt'),
        'finishedAt': status_data.get('finishedAt'),
        'updatedAt': status_data.get('updatedAt'),
    }


def extract_host_bundle(app_image, install_dir=INSTALL):
    """Copy updated host scripts/docker helpers packaged in the runtime app image."""
    with tempfile.TemporaryDirectory(prefix='my-drive-bundle-') as tmp_dir:
        created = subprocess.run(['docker', 'create', app_image], text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if created.returncode != 0:
            return False
        cid = created.stdout.strip()
        try:
            copied = subprocess.run(['docker', 'cp', f'{cid}:{HOST_BUNDLE_CONTAINER_DIR}/.', tmp_dir],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if copied.returncode != 0:
                return False
            bundle_root = Path(tmp_dir)
            if not (bundle_root / 'scripts' / 'vps.py').is_file():
                return False
            for directory in ('scripts', 'docker'):
                src = bundle_root / directory
                if src.is_dir():
                    shutil.copytree(src, Path(install_dir) / directory, dirs_exist_ok=True)
            for script in (Path(install_dir) / 'scripts').glob('*.sh'):
                script.chmod(0o700)
            return True
        finally:
            subprocess.run(['docker', 'rm', '-f', cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def parse_proc_meminfo(text):
    values = {}
    for line in text.splitlines():
        if ':' not in line:
            continue
        key, rest = line.split(':', 1)
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            kib = int(parts[0])
            values[key] = kib * 1024
        except ValueError:
            continue
    total = values.get('MemTotal', 0)
    avail = values.get('MemAvailable', values.get('MemFree', 0))
    swap_total = values.get('SwapTotal', 0)
    swap_free = values.get('SwapFree', 0)
    return {
        'memory': {'totalBytes': total, 'availableBytes': avail, 'usedBytes': max(0, total - avail)},
        'swap': {'totalBytes': swap_total, 'freeBytes': swap_free, 'usedBytes': max(0, swap_total - swap_free)},
    }


def parse_compose_ps_json(raw):
    text = (raw or '').strip()
    if not text:
        return []
    items = []
    if text.startswith('['):
        parsed = json.loads(text)
        items = parsed if isinstance(parsed, list) else []
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    items.append(obj)
            except json.JSONDecodeError:
                continue
    services = []
    for item in items:
        if not isinstance(item, dict):
            continue
        services.append({
            'name': str(item.get('Name') or ''),
            'service': str(item.get('Service') or ''),
            'state': str(item.get('State') or 'unknown').lower(),
            'health': str(item.get('Health') or '').lower() or None,
            'status': str(item.get('Status') or ''),
            'image': str(item.get('Image') or ''),
            'runningFor': str(item.get('RunningFor') or '') or None,
        })
    return services


def read_cpu_usage_percent():
    def snapshot():
        first = Path('/proc/stat').read_text().splitlines()[0].split()[1:]
        nums = [int(x) for x in first]
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        return sum(nums), idle
    try:
        t1, i1 = snapshot()
        time.sleep(0.12)
        t2, i2 = snapshot()
        dt = t2 - t1
        di = i2 - i1
        if dt <= 0:
            return None
        return round(max(0.0, min(100.0, (dt - di) * 100.0 / dt)), 1)
    except (OSError, ValueError, IndexError):
        return None


def read_os_name():
    import platform
    try:
        for line in Path('/etc/os-release').read_text().splitlines():
            if line.startswith('PRETTY_NAME='):
                return line.split('=', 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.platform()


def systemd_unit_active(unit_name):
    res = subprocess.run(['systemctl', 'is-active', unit_name], text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    out = (res.stdout or '').strip()
    return out or ('active' if res.returncode == 0 else 'unknown')


def host_overview_payload(state):
    import platform
    cfg = state.get('config', {}) if isinstance(state, dict) else {}
    mem_data = {'memory': {'totalBytes': 0, 'availableBytes': 0, 'usedBytes': 0},
                'swap': {'totalBytes': 0, 'freeBytes': 0, 'usedBytes': 0}}
    try:
        mem_data = parse_proc_meminfo(Path('/proc/meminfo').read_text())
    except OSError:
        pass
    uptime_seconds = None
    try:
        uptime_seconds = int(float(Path('/proc/uptime').read_text().split()[0]))
    except (OSError, ValueError, IndexError):
        pass
    try:
        load_avg = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        load_avg = []
    disks = []
    seen_devs = set()
    candidates = [
        ('Root OS', '/'),
        ('MyDrive Core', str(INSTALL)),
        ('HDD Storage', cfg.get('storage')),
        ('SSD Previews', cfg.get('previews')),
        ('Database', cfg.get('database')),
    ]
    for label, raw_path in candidates:
        if not raw_path or not os.path.exists(raw_path):
            continue
        try:
            st = os.stat(raw_path)
            vfs = os.statvfs(raw_path)
            key = (st.st_dev, vfs.f_blocks)
            if key in seen_devs:
                continue
            seen_devs.add(key)
            total = vfs.f_frsize * vfs.f_blocks
            free = vfs.f_frsize * vfs.f_bavail
            used = max(0, vfs.f_frsize * (vfs.f_blocks - vfs.f_bfree))
            pct = round((used / total) * 100.0, 1) if total > 0 else 0.0
            disks.append({
                'label': label,
                'path': str(raw_path),
                'totalBytes': total,
                'usedBytes': used,
                'freeBytes': free,
                'percentUsed': pct,
            })
        except OSError:
            continue
    services = []
    try:
        services = parse_compose_ps_json(compose('ps', '--all', '--format', 'json', capture=True))
    except Exception:
        services = []
    images = cfg.get('images', {}) if isinstance(cfg.get('images'), dict) else {}
    return {
        'connected': True,
        'hostname': socket.gethostname(),
        'osName': read_os_name(),
        'kernel': platform.release(),
        'arch': platform.machine(),
        'uptimeSeconds': uptime_seconds,
        'loadAverage': load_avg,
        'cpuCores': os.cpu_count() or 1,
        'cpuUsagePercent': read_cpu_usage_percent(),
        'memory': mem_data['memory'],
        'swap': mem_data['swap'],
        'disks': disks,
        'core': {
            'installDir': str(INSTALL),
            'tlsMode': cfg.get('tls'),
            'host': cfg.get('host'),
            'lanEnabled': cfg.get('lan_enabled', cfg.get('tls') == 'cloudflare'),
            'lanPort': int(cfg.get('lan_port', 3000) or 3000),
            'lanBind': cfg.get('lan_bind') or '',
            'myDriveService': systemd_unit_active('my-drive.service'),
            'updaterService': systemd_unit_active('my-drive-updater.service'),
            'imageTrack': images.get('app'),
        },
        'services': services,
    }


def is_virtual_interface(name):
    return (
        name == 'lo'
        or name == 'docker0'
        or name.startswith(('br-', 'veth', 'tun', 'tap', 'wg', 'tailscale', 'virbr'))
    )


def parse_ip_addr_json(addr_raw, route_raw='[]'):
    interfaces = []
    default_gateways = {}
    try:
        routes = json.loads(route_raw or '[]')
        for route in routes:
            if isinstance(route, dict) and route.get('dst') == 'default' and route.get('dev'):
                if route.get('gateway'):
                    default_gateways[route['dev']] = str(route['gateway'])
    except (json.JSONDecodeError, TypeError):
        pass
    try:
        items = json.loads(addr_raw or '[]')
    except (json.JSONDecodeError, TypeError):
        items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get('ifname') or '')
        if not name or is_virtual_interface(name):
            continue
        ipv4 = []
        is_dhcp = False
        for info in item.get('addr_info') or []:
            if not isinstance(info, dict) or info.get('family') != 'inet':
                continue
            local = info.get('local')
            prefix = info.get('prefixlen')
            if local and prefix is not None:
                ipv4.append(f'{local}/{prefix}')
            if info.get('dynamic'):
                is_dhcp = True
        interfaces.append({
            'name': name,
            'state': str(item.get('operstate') or 'unknown').lower(),
            'mac': str(item.get('address') or '') or None,
            'ipv4': ipv4,
            'gateway': default_gateways.get(name),
            'dhcp': is_dhcp,
        })
    return interfaces


def read_resolv_dns(path=Path('/etc/resolv.conf')):
    servers = []
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[0] == 'nameserver':
                try:
                    ip = str(ipaddress.IPv4Address(parts[1]))
                    if ip not in {'127.0.0.53', '127.0.0.54'} and ip not in servers:
                        servers.append(ip)
                except ValueError:
                    pass
    except OSError:
        pass
    return servers


def build_netplan_yaml(interface, mode, address_cidr=None, gateway=None, dns=None):
    iface = (interface or '').strip()
    if not IFACE_RE.fullmatch(iface) or is_virtual_interface(iface):
        raise ValueError('select a valid physical network interface')
    mode = (mode or '').strip().lower()
    if mode not in {'dhcp', 'static'}:
        raise ValueError('network mode must be dhcp or static')
    if mode == 'dhcp':
        return {
            'interface': iface,
            'mode': 'dhcp',
            'addressCidr': None,
            'gateway': None,
            'dns': [],
            'yaml': (
                'network:\n'
                '  version: 2\n'
                '  ethernets:\n'
                f'    {iface}:\n'
                '      dhcp4: true\n'
            ),
        }
    if not address_cidr or not gateway:
        raise ValueError('static mode requires IPv4 address/CIDR and gateway')
    try:
        iface_addr = ipaddress.IPv4Interface(str(address_cidr).strip())
    except ValueError:
        raise ValueError('invalid IPv4 CIDR (for example 192.168.0.151/24)') from None
    if iface_addr.network.prefixlen < 8 or iface_addr.network.prefixlen > 32:
        raise ValueError('subnet prefix length must be between /8 and /32')
    if iface_addr.ip.is_unspecified or iface_addr.ip.is_loopback or iface_addr.ip.is_multicast:
        raise ValueError('invalid host IPv4 address')
    if iface_addr.network.prefixlen <= 30 and iface_addr.ip in {iface_addr.network.network_address, iface_addr.network.broadcast_address}:
        raise ValueError('IP address cannot be network or broadcast address')
    normalized_cidr = f'{iface_addr.ip}/{iface_addr.network.prefixlen}'
    try:
        gw_ip = str(ipaddress.IPv4Address(str(gateway).strip()))
    except ValueError:
        raise ValueError('invalid gateway IPv4 address') from None
    dns_list = []
    for raw_dns in (dns or [gw_ip, '1.1.1.1']):
        raw_dns = str(raw_dns).strip()
        if not raw_dns:
            continue
        try:
            ip_str = str(ipaddress.IPv4Address(raw_dns))
        except ValueError:
            raise ValueError(f'invalid DNS IPv4 address: {raw_dns}') from None
        if ip_str not in dns_list:
            dns_list.append(ip_str)
    if len(dns_list) > 4:
        raise ValueError('specify at most 4 DNS servers')
    dns_block = ''
    if dns_list:
        dns_items = ', '.join(dns_list)
        dns_block = (
            '      nameservers:\n'
            f'        addresses: [{dns_items}]\n'
        )
    yaml_text = (
        'network:\n'
        '  version: 2\n'
        '  ethernets:\n'
        f'    {iface}:\n'
        '      dhcp4: false\n'
        f'      addresses:\n        - {normalized_cidr}\n'
        '      routes:\n'
        '        - to: default\n'
        f'          via: {gw_ip}\n'
        f'{dns_block}'
    )
    return {
        'interface': iface,
        'mode': 'static',
        'addressCidr': normalized_cidr,
        'gateway': gw_ip,
        'dns': dns_list,
        'yaml': yaml_text,
    }


def read_ufw_status():
    if not shutil.which('ufw'):
        return {'installed': False, 'active': False, 'rules': []}
    res = subprocess.run(['ufw', 'status'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    output = (res.stdout or '').strip()
    lines = output.splitlines()
    active = any(line.lower().startswith('status: active') for line in lines)
    rules = [line.strip() for line in lines[3:] if line.strip() and not line.strip().startswith('--')] if active and len(lines) > 3 else []
    return {'installed': True, 'active': active, 'rules': rules[:30]}


def read_pending_netplan():
    if not NETPLAN_PENDING_PATH.is_file():
        return None
    try:
        data = json.loads(NETPLAN_PENDING_PATH.read_text())
        if not isinstance(data, dict):
            return None
        from datetime import datetime, timezone
        expires_at = data.get('expiresAt')
        remaining = None
        if expires_at:
            dt = datetime.fromisoformat(expires_at)
            remaining = max(0, int((dt - datetime.now(timezone.utc)).total_seconds()))
        return {**data, 'remainingSeconds': remaining}
    except Exception:
        return None


def _lan_tls_token_path():
    return INSTALL / 'lan-certs' / 'cf.token'


def read_lan_tls_cf_token():
    path = _lan_tls_token_path()
    if not path.is_file():
        return ''
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def write_lan_tls_cf_token(token):
    cert_dir = INSTALL / 'lan-certs'
    cert_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
    atomic(_lan_tls_token_path(), token.strip() + '\n', mode=0o600)


def lan_tls_status_payload(state):
    cfg = state.get('config', {}) if isinstance(state, dict) else {}
    mode = str(cfg.get('lan_tls_mode') or 'off').strip().lower()
    if mode not in ('off', 'letsencrypt_cloudflare', 'internal_ca'):
        mode = 'off'
    default_port = 443 if cfg.get('tls') == 'cloudflare' else 8443
    port = int(cfg.get('lan_tls_port') or default_port)
    host = str(cfg.get('lan_tls_host') or '').strip()
    ip = str(cfg.get('lan_tls_ip') or '').strip()
    bind = str(cfg.get('lan_tls_bind') or '').strip()
    url = None
    if mode != 'off' and host:
        url = f'https://{host}' if port == 443 else f'https://{host}:{port}'
    cert_info = None
    if mode == 'letsencrypt_cloudflare':
        try:
            lan_tls_mod = local_module('lan_tls')
            cert_info = lan_tls_mod.inspect_certificate(INSTALL / 'lan-certs' / 'fullchain.pem')
        except Exception:
            cert_info = None
    ca_path = INSTALL / 'caddy-data' / 'caddy' / 'pki' / 'authorities' / 'local' / 'root.crt'
    return {
        'mode': mode,
        'host': host,
        'ip': ip,
        'port': port,
        'bind': bind,
        'url': url,
        'hasCloudflareToken': bool(read_lan_tls_cf_token()),
        'certificate': cert_info,
        'caAvailable': ca_path.is_file(),
    }


def network_status_payload(state):
    cfg = state.get('config', {}) if isinstance(state, dict) else {}
    addr_res = subprocess.run(['ip', '-j', 'addr', 'show'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    route_res = subprocess.run(['ip', '-j', 'route', 'show'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    interfaces = parse_ip_addr_json(addr_res.stdout or '[]', route_res.stdout or '[]')
    netplan_available = shutil.which('netplan') is not None and NETPLAN_DIR.is_dir()
    return {
        'connected': True,
        'netplanAvailable': netplan_available,
        'interfaces': interfaces,
        'dnsServers': read_resolv_dns(),
        'ufw': read_ufw_status(),
        'lan': {
            'enabled': bool(cfg.get('lan_enabled', cfg.get('tls') == 'cloudflare')),
            'port': int(cfg.get('lan_port', 3000) or 3000),
            'bind': str(cfg.get('lan_bind') or ''),
            'tlsMode': cfg.get('tls'),
            'host': cfg.get('host'),
        },
        'lanTls': lan_tls_status_payload(state),
        'pendingRollback': read_pending_netplan(),
    }


def _restore_netplan_backup():
    if not NETPLAN_BACKUP_DIR.is_dir():
        return False
    for existing in NETPLAN_DIR.glob('*.yaml'):
        existing.unlink(missing_ok=True)
    for backup in NETPLAN_BACKUP_DIR.glob('*.yaml'):
        shutil.copy2(backup, NETPLAN_DIR / backup.name)
        os.chmod(NETPLAN_DIR / backup.name, 0o600)
    NETPLAN_PENDING_PATH.unlink(missing_ok=True)
    if shutil.which('netplan'):
        subprocess.run(['netplan', 'apply'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def apply_netplan_with_rollback(spec, timeout_seconds=90):
    from datetime import datetime, timedelta, timezone
    if not shutil.which('netplan') or not NETPLAN_DIR.is_dir():
        raise ValueError('netplan is not available on this host')
    timeout_seconds = max(45, min(180, int(timeout_seconds)))
    NETPLAN_BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    for old in NETPLAN_BACKUP_DIR.glob('*.yaml'):
        old.unlink()
    for existing in NETPLAN_DIR.glob('*.yaml'):
        shutil.copy2(existing, NETPLAN_BACKUP_DIR / existing.name)
        os.chmod(NETPLAN_BACKUP_DIR / existing.name, 0o600)

    # Move non-managed netplan files temporarily or keep override in 99-my-drive-managed.yaml?
    # Replacing existing netplan ethernets cleanly avoids conflicting DHCP + static routes on the same NIC.
    for existing in NETPLAN_DIR.glob('*.yaml'):
        if existing != NETPLAN_MANAGED_FILE:
            existing.unlink()
    atomic(NETPLAN_MANAGED_FILE, spec['yaml'], mode=0o600)

    gen = subprocess.run(['netplan', 'generate'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if gen.returncode != 0:
        _restore_netplan_backup()
        raise ValueError(f"netplan validation failed: {(gen.stdout or '').strip()[:300]}")

    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(seconds=timeout_seconds)).isoformat()
    pending = {
        'interface': spec['interface'],
        'mode': spec['mode'],
        'addressCidr': spec['addressCidr'],
        'gateway': spec['gateway'],
        'dns': spec['dns'],
        'appliedAt': now.isoformat(),
        'expiresAt': expires_at,
        'timeoutSeconds': timeout_seconds,
    }
    atomic(NETPLAN_PENDING_PATH, json.dumps(pending, indent=2) + '\n')

    app = subprocess.run(['netplan', 'apply'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if app.returncode != 0:
        _restore_netplan_backup()
        raise ValueError(f"netplan apply failed and previous config was restored: {(app.stdout or '').strip()[:300]}")

    # Schedule durable safety rollback if the operator does not confirm before timeout.
    subprocess.Popen(
        ['systemd-run', '--quiet', f'--on-active={timeout_seconds}', '/usr/local/bin/my-drive', 'netplan-rollback-if-pending'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return pending


def updater_serve():
    import fcntl
    import http.server
    import socketserver
    import threading
    from datetime import datetime, timezone

    ensure_updater_runtime_dir()
    if UPDATER_SOCKET.exists():
        UPDATER_SOCKET.unlink()

    job_lock = threading.Lock()
    current = read_updater_status()
    if current.get('status') == 'running':
        write_updater_status({
            **current,
            'status': 'failed',
            'phase': 'interrupted',
            'message': 'Updater service restarted while an update was in progress.',
            'finishedAt': datetime.now(timezone.utc).isoformat(),
        })

    def load_install_state():
        return json.loads((INSTALL / 'state.json').read_text())

    def run_update_worker(target_tag):
        started_at = datetime.now(timezone.utc).isoformat()
        write_updater_status({
            'status': 'running',
            'phase': 'starting',
            'message': f"Starting host update{f' to {target_tag}' if target_tag else ''}...",
            'targetTag': target_tag,
            'startedAt': started_at,
            'finishedAt': None,
        })
        cmd = ['/usr/local/bin/my-drive', 'update', '--non-interactive']
        if target_tag:
            cmd += ['--tag', target_tag]
        env = dict(os.environ, MY_DRIVE_UPDATER_SUBPROCESS='1')
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
        last_line = None
        phase = 'pulling'
        for raw_line in iter(proc.stdout.readline, ''):
            line = raw_line.strip()
            if not line:
                continue
            last_line = line
            lower = line.lower()
            if 'phase:' in lower:
                _, parsed_phase = line.split(':', 1)
                phase = parsed_phase.strip().split(' ', 1)[0]
            elif 'restarting' in lower or 'starting my drive' in lower or 'waiting until' in lower:
                phase = 'restarting'
            elif 'already up to date' in lower or 'updated and verified' in lower:
                phase = 'verifying'
            write_updater_status({
                'status': 'running',
                'phase': phase,
                'message': line[:400],
                'targetTag': target_tag,
                'startedAt': started_at,
                'finishedAt': None,
            })
        rc = proc.wait()
        finished_at = datetime.now(timezone.utc).isoformat()
        if rc == 0:
            write_updater_status({
                'status': 'succeeded',
                'phase': 'completed',
                'message': (last_line or 'Updated and verified.')[:400],
                'targetTag': target_tag,
                'startedAt': started_at,
                'finishedAt': finished_at,
            })
            # Reload unit cleanly after the HTTP status has been written if scripts changed.
            subprocess.Popen(['systemd-run', '--quiet', '--on-active=3', 'systemctl', 'try-restart', 'my-drive-updater.service'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            write_updater_status({
                'status': 'failed',
                'phase': 'failed',
                'message': (last_line or 'Update failed; inspect my-drive status/logs.')[:400],
                'targetTag': target_tag,
                'startedAt': started_at,
                'finishedAt': finished_at,
            })

    class Handler(http.server.BaseHTTPRequestHandler):
        def address_string(self):
            return 'unix-socket'

        def log_message(self, format, *args):
            return

        def send_json(self, code, payload):
            encoded = (json.dumps(payload) + '\n').encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(encoded)

        def read_json_body(self):
            length = int(self.headers.get('Content-Length') or '0')
            if length > 65536:
                raise ValueError('request body too large')
            raw = self.rfile.read(length) if length > 0 else b'{}'
            data = json.loads(raw.decode('utf-8'))
            if not isinstance(data, dict):
                raise ValueError('JSON object required')
            return data

        def do_GET(self):
            from urllib.parse import parse_qs, urlparse
            parsed_url = urlparse(self.path)
            if parsed_url.path == '/status':
                try:
                    state = load_install_state()
                    self.send_json(200, _updater_status_payload(state))
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if parsed_url.path == '/host/overview':
                try:
                    state = load_install_state()
                    self.send_json(200, host_overview_payload(state))
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if parsed_url.path == '/network':
                try:
                    state = load_install_state()
                    self.send_json(200, network_status_payload(state))
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if parsed_url.path == '/services/logs':
                try:
                    qs = parse_qs(parsed_url.query)
                    svc = (qs.get('service') or ['all'])[0].strip()
                    if svc not in {'all', 'updater', *ALLOWED_SERVICES}:
                        raise ValueError('unsupported service for logs')
                    try:
                        tail = int((qs.get('tail') or ['120'])[0])
                    except ValueError:
                        raise ValueError('tail must be an integer') from None
                    tail = max(10, min(400, tail))
                    if svc == 'updater':
                        res = subprocess.run(
                            ['journalctl', '-u', 'my-drive-updater.service', '-n', str(tail), '--no-pager', '-o', 'short-iso'],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False,
                        )
                        raw = res.stdout or ''
                    else:
                        if svc != 'all':
                            compose_model = json.loads((INSTALL / 'compose.yaml').read_text())
                            if svc not in compose_model.get('services', {}):
                                raise ValueError(f'service {svc} is not configured in compose.yaml')
                        raw = compose('logs', '--tail', str(tail), '--no-color',
                                      *([] if svc == 'all' else [svc]), capture=True)
                    lines = raw.splitlines()[-tail:]
                    self.send_json(200, {'service': svc, 'tail': tail, 'lines': lines})
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if parsed_url.path == '/network/lan-tls/ca.crt':
                try:
                    ca_path = INSTALL / 'caddy-data' / 'caddy' / 'pki' / 'authorities' / 'local' / 'root.crt'
                    if not ca_path.is_file():
                        self.send_json(404, {'error': 'not_found', 'message': 'Local CA root certificate has not been generated yet. Enable Local CA LAN SSL first.'})
                        return
                    self.send_json(200, {'pem': ca_path.read_text()})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            self.send_json(404, {'error': 'not_found'})

        def do_POST(self):
            if self.path == '/network/lan-tls':
                try:
                    body = self.read_json_body()
                    lan_tls_mod = local_module('lan_tls')
                    cf_mod = local_module('cloudflare')
                    spec = lan_tls_mod.validate_lan_tls_config(
                        body.get('mode', 'off'),
                        body.get('host', ''),
                        body.get('ip', ''),
                        body.get('port', 443),
                        body.get('bind', ''),
                    )
                    configure_ufw = bool(body.get('configureUfw'))
                    cf_token_input = str(body.get('cloudflareToken') or '').strip()

                    with job_lock:
                        state = load_install_state()
                        if spec['mode'] == 'letsencrypt_cloudflare':
                            token = cf_token_input or read_lan_tls_cf_token()
                            if not token:
                                raise ValueError('Cloudflare API token (Zone DNS Edit + Zone Read) is required for Let\'s Encrypt DNS-01 LAN SSL')
                            token = cf_mod.valid_token(token)
                            write_lan_tls_cf_token(token)
                            cf_mod.upsert_a_record(token, spec['host'], spec['ip'])
                            cert_dir = INSTALL / 'lan-certs'
                            fullchain = cert_dir / 'fullchain.pem'
                            existing = lan_tls_mod.inspect_certificate(fullchain)
                            need_issue = (
                                not existing.get('valid')
                                or existing.get('needsRenewal')
                                or spec['host'] not in (existing.get('sans') or [])
                            )
                            if need_issue:
                                lan_tls_mod.issue_letsencrypt_cloudflare(
                                    cert_dir,
                                    spec['host'],
                                    token,
                                    email=state['config'].get('email'),
                                )
                        elif spec['mode'] == 'internal_ca':
                            (INSTALL / 'lan-certs').mkdir(parents=True, exist_ok=True, mode=0o750)

                        state['config']['lan_tls_mode'] = spec['mode']
                        state['config']['lan_tls_host'] = spec['host']
                        state['config']['lan_tls_ip'] = spec['ip']
                        state['config']['lan_tls_port'] = spec['port']
                        state['config']['lan_tls_bind'] = spec['bind']
                        save(state)

                        atomic(INSTALL / 'Caddyfile', caddyfile(state['config']))
                        compose_path = INSTALL / 'compose.yaml'
                        model = json.loads(compose_path.read_text())
                        ensure_lan_tls_compose(model, state['config'])
                        atomic(compose_path, json.dumps(model, indent=2) + '\n')

                    if configure_ufw and shutil.which('ufw') and spec['mode'] != 'off':
                        ufw = read_ufw_status()
                        if ufw.get('active'):
                            for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'):
                                subprocess.run(
                                    ['ufw', 'allow', 'from', cidr, 'to', 'any', 'port', str(spec['port']), 'proto', 'tcp'],
                                    check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                )

                    def _apply_proxy():
                        time.sleep(0.25)
                        compose('up', '-d', '--force-recreate', 'proxy')

                    threading.Thread(target=_apply_proxy, daemon=True).start()
                    self.send_json(202, network_status_payload(state))
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/network/lan-tls/renew':
                try:
                    lan_tls_mod = local_module('lan_tls')
                    with job_lock:
                        state = load_install_state()
                        cfg = state.get('config', {})
                        if cfg.get('lan_tls_mode') != 'letsencrypt_cloudflare':
                            raise ValueError('Let\'s Encrypt LAN SSL is not currently enabled')
                        host = str(cfg.get('lan_tls_host') or '').strip()
                        token = read_lan_tls_cf_token()
                        if not host or not token:
                            raise ValueError('Saved LAN SSL hostname or Cloudflare API token is missing')
                        lan_tls_mod.issue_letsencrypt_cloudflare(
                            INSTALL / 'lan-certs',
                            host,
                            token,
                            email=cfg.get('email'),
                        )

                    def _reload_proxy():
                        time.sleep(0.2)
                        try:
                            compose('exec', '-T', 'proxy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')
                        except Exception:
                            compose('restart', 'proxy')

                    threading.Thread(target=_reload_proxy, daemon=True).start()
                    self.send_json(200, network_status_payload(state))
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/network/lan':
                try:
                    body = self.read_json_body()
                    lan_enabled = bool(body.get('enabled'))
                    lan_port = int(body.get('port', 3000))
                    if lan_port < 1024 or lan_port > 65535:
                        raise ValueError('LAN port must be between 1024 and 65535')
                    lan_bind = str(body.get('bind') or '').strip()
                    if lan_bind:
                        try:
                            lan_bind = str(ipaddress.IPv4Address(lan_bind))
                        except ValueError:
                            raise ValueError('LAN bind address must be a valid IPv4 address') from None
                    configure_ufw = bool(body.get('configureUfw'))

                    with job_lock:
                        state = load_install_state()
                        state['config']['lan_enabled'] = lan_enabled
                        state['config']['lan_port'] = lan_port
                        state['config']['lan_bind'] = lan_bind
                        save(state)
                        compose_path = INSTALL / 'compose.yaml'
                        model = json.loads(compose_path.read_text())
                        ensure_lan_compose(model, state['config'], force=True)
                        atomic(compose_path, json.dumps(model, indent=2) + '\n')

                    if configure_ufw and shutil.which('ufw'):
                        ufw = read_ufw_status()
                        if ufw.get('active') and lan_enabled:
                            for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'):
                                subprocess.run(['ufw', 'allow', 'from', cidr, 'to', 'any', 'port', str(lan_port), 'proto', 'tcp'],
                                               check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                    def _apply_lan():
                        time.sleep(0.25)
                        compose('up', '-d', 'app')

                    threading.Thread(target=_apply_lan, daemon=True).start()
                    self.send_json(202, network_status_payload(state))
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/network/apply':
                try:
                    body = self.read_json_body()
                    spec = build_netplan_yaml(
                        body.get('interface'),
                        body.get('mode'),
                        body.get('addressCidr'),
                        body.get('gateway'),
                        body.get('dns'),
                    )
                    timeout_seconds = int(body.get('confirmTimeoutSeconds', 90))
                    with job_lock:
                        pending = apply_netplan_with_rollback(spec, timeout_seconds)
                        state = load_install_state()
                    self.send_json(202, {**network_status_payload(state), 'pendingRollback': {**pending, 'remainingSeconds': timeout_seconds}})
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/network/confirm':
                try:
                    with job_lock:
                        NETPLAN_PENDING_PATH.unlink(missing_ok=True)
                        state = load_install_state()
                    self.send_json(200, network_status_payload(state))
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/network/rollback':
                try:
                    with job_lock:
                        restored = _restore_netplan_backup()
                        state = load_install_state()
                    if not restored:
                        self.send_json(400, {'error': 'invalid_request', 'message': 'No netplan backup available to restore.'})
                        return
                    self.send_json(200, network_status_payload(state))
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path == '/services/restart':
                try:
                    body = self.read_json_body()
                    svc = str(body.get('service') or '').strip()
                    if svc not in {'all', *ALLOWED_SERVICES}:
                        raise ValueError('unsupported service for restart')
                    if svc != 'all':
                        compose_model = json.loads((INSTALL / 'compose.yaml').read_text())
                        if svc not in compose_model.get('services', {}):
                            raise ValueError(f'service {svc} is not configured in compose.yaml')

                    def _do_restart():
                        time.sleep(0.25)
                        if svc == 'all':
                            compose('restart')
                        else:
                            compose('restart', svc)

                    threading.Thread(target=_do_restart, daemon=True).start()
                    self.send_json(202, {
                        'ok': True,
                        'service': svc,
                        'message': f'Restart initiated for {svc}.',
                    })
                except ValueError as error:
                    self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
                except Exception as error:
                    self.send_json(500, {'error': 'internal_error', 'message': str(error)})
                return
            if self.path != '/update':
                self.send_json(404, {'error': 'not_found'})
                return
            try:
                body = self.read_json_body()
                target_tag = body.get('targetTag')
                if target_tag is not None:
                    if not isinstance(target_tag, str) or not RELEASE_TAG_RE.fullmatch(target_tag.strip()):
                        raise ValueError('invalid release tag')
                    target_tag = target_tag.strip()
                with job_lock:
                    state = load_install_state()
                    status_now = read_updater_status()
                    if status_now.get('status') == 'running':
                        self.send_json(409, {'error': 'update_in_progress', 'message': 'An update is already running.'})
                        return
                    if not state.get('config', {}).get('images'):
                        self.send_json(400, {'error': 'invalid_request', 'message': 'Host installation has no configured registry image track.'})
                        return
                    worker = threading.Thread(target=run_update_worker, args=(target_tag,), daemon=True)
                    worker.start()
                self.send_json(202, _updater_status_payload(state))
            except ValueError as error:
                self.send_json(400, {'error': 'invalid_request', 'message': str(error)})
            except Exception as error:
                self.send_json(500, {'error': 'internal_error', 'message': str(error)})

    class ThreadedUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    def _lan_tls_auto_renew_loop():
        while True:
            time.sleep(12 * 3600)
            try:
                lan_tls_mod = local_module('lan_tls')
                with job_lock:
                    state = load_install_state()
                    cfg = state.get('config', {})
                    if cfg.get('lan_tls_mode') != 'letsencrypt_cloudflare':
                        continue
                    host = str(cfg.get('lan_tls_host') or '').strip()
                    token = read_lan_tls_cf_token()
                    cert_path = INSTALL / 'lan-certs' / 'fullchain.pem'
                    if not host or not token or not lan_tls_mod.needs_renewal(cert_path, threshold_days=30):
                        continue
                    lan_tls_mod.issue_letsencrypt_cloudflare(
                        INSTALL / 'lan-certs',
                        host,
                        token,
                        email=cfg.get('email'),
                    )
                try:
                    compose('exec', '-T', 'proxy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')
                except Exception:
                    compose('restart', 'proxy')
            except Exception as error:
                print(f'lan-tls auto-renewal failed: {error}', file=sys.stderr)

    threading.Thread(target=_lan_tls_auto_renew_loop, daemon=True).start()

    with ThreadedUnixServer(str(UPDATER_SOCKET), Handler) as server:
        os.chmod(UPDATER_SOCKET, 0o660)
        os.chown(UPDATER_SOCKET, 0, 10001)
        server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    setup = sub.add_parser('install')
    setup.add_argument('--config', help='private JSON configuration; omit for wizard')
    setup.add_argument('--prepare-only', action='store_true', help='prepare files/images without starting or enabling service (recovery)')
    setup.add_argument('--cli', action='store_true', help='answer setup questions in the terminal instead of the web wizard')
    setup.add_argument('--web-listen', default='0.0.0.0',
                       help='wizard address; default answers private LAN clients only. Use 127.0.0.1 + SSH tunnel on a VPS')
    setup.add_argument('--web-port', type=int, default=8090)
    setup.add_argument('--prebuilt', action='store_true', help='download CI-published images; never build locally')
    setup.add_argument('--image-prefix', default='ghcr.io/vantanminh/my-drive')
    setup.add_argument('--image-tag', default='latest')
    for command in ('start', 'stop', 'status', 'check'):
        sub.add_parser(command)
    logs = sub.add_parser('logs')
    logs.add_argument('service', nargs='?', choices=['app', 'db', 'proxy', 'document-preview', 'media-indexer', 'media-indexer-db-setup'])
    backup_parser = sub.add_parser('backup')
    backup_parser.add_argument('--backup-root', required=True)
    backup_parser.add_argument('--recipient', required=True, help='age PUBLIC recipient (keep private identity offline)')
    update_parser = sub.add_parser('update', help='pull configured registry images and verify the deployment')
    update_parser.add_argument('--backup-root', help='encrypted backup destination; saved after a successful backup')
    update_parser.add_argument('--recipient', help='age PUBLIC recipient; saved after a successful backup')
    update_parser.add_argument('--tag', help='optional release tag (for example v0.1.2) on the configured registry track')
    update_parser.add_argument('--non-interactive', action='store_true', help='never prompt on stdin when invoked from automation')
    mode = update_parser.add_mutually_exclusive_group()
    mode.add_argument('--source', help='reviewed checkout of the release to build; no automatic git pull')
    mode.add_argument('--images', help='JSON map of own registry image references for this release')
    sub.add_parser('updater-serve', help='run the local Unix-socket host updater bridge')
    sub.add_parser('netplan-rollback-if-pending', help='revert unconfirmed netplan changes on timeout')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('run as root on Linux')
    os.umask(0o077)
    if args.command == 'updater-serve':
        updater_serve()
        return
    if args.command == 'netplan-rollback-if-pending':
        if NETPLAN_PENDING_PATH.is_file():
            _restore_netplan_backup()
        return
    # Serialize install/start/update/backup so a reboot or second wizard cannot race secrets/config.
    import fcntl
    with open('/run/lock/my-drive-installer.lock', 'a') as lock:
        if args.command not in {'logs', 'status'}:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'install':
            args.wizard = None
            fresh = not (INSTALL / 'state.json').exists()
            if fresh and not args.config and not args.cli:
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                setup_web = local_module('setup_web')
                global _progress_hook
                args.wizard = setup_web.serve(sys.modules[__name__], args.prebuilt, args.web_listen, args.web_port)
                _progress_hook = args.wizard.progress
            try:
                state = install(args)
                if not args.prepare_only:
                    # systemd starts a separate process, which must acquire this same lock.
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    progress('Starting My Drive and waiting until it is ready')
                    run('systemctl', 'restart', 'my-drive.service')
                    token = args.wizard.config.get('cf_token') if args.wizard else None
                    if state.get('cloudflare') and token:
                        verify_tunnel(state, token)
            except BaseException as error:
                if args.wizard:
                    args.wizard.failed(str(error) if isinstance(error, ValueError) else
                                       f'{type(error).__name__}: inspect "sudo my-drive logs" and re-run the installer.')
                    if not isinstance(error, KeyboardInterrupt):
                        print('Installation failed; details are shown in the browser.', file=sys.stderr)
                        setup_web.wait_and_close(args.wizard, 600)
                raise
            if args.prepare_only:
                print('Prepared without starting/enabling the service. Complete recovery, then systemctl enable --now my-drive.')
                return
            scheme = 'http' if state['config']['tls'] == 'http' else 'https'
            if args.wizard:
                password = args.wizard.config.get('owner_password', '')
                args.wizard.done(f"{scheme}://{state['config']['host']}", password)
                print('Installed. Close the wizard page (or wait 15 minutes) to finish.')
                setup_web.wait_and_close(args.wizard)
            print(f"Installed: {scheme}://{state['config']['host']}\nCredentials: /opt/my-drive/owner-credentials.txt (root only). Copy securely, then delete this file.")
            return
        state = json.loads((INSTALL / 'state.json').read_text())
        if args.command == 'check':
            check(state)
            print('Filesystem UUIDs and mount locations match.')
        elif args.command == 'start':
            start(state)
        elif args.command == 'stop':
            compose('stop', '-t', '30')
        elif args.command == 'status':
            compose('ps', '--all')
        elif args.command == 'logs':
            compose('logs', '--tail', '100', *([args.service] if args.service else []))
        elif args.command == 'backup':
            backup(state, args)
        elif args.command == 'update':
            candidate = dict(state['config'], owner_password=secrets.token_urlsafe(32))
            source = SOURCE
            if args.source:
                source = Path(args.source).resolve(strict=True)
                if not (source / 'Dockerfile').is_file():
                    raise ValueError('--source must contain a reviewed My Drive checkout')
                candidate['images'] = {}
            elif args.images:
                candidate['images'] = json.loads(Path(args.images).read_text())
                if not candidate['images']:
                    raise ValueError('--images must contain release image references')
            elif state['config'].get('images'):
                # Re-pull the same configured registry tags (or target release tag) and resolve to digests.
                base_images = dict(state['config']['images'])
                candidate['images'] = apply_release_tag(base_images, args.tag) if args.tag else base_images
            else:
                raise ValueError('this installation has no registry update track; use --source or --images')
            candidate = validate(candidate)
            print('phase: pulling Downloading and verifying container images', flush=True)
            images = build_images(candidate, source)  # Build/pull while old app remains available.
            image_env = {'app': 'MY_DRIVE_IMAGE', 'document-preview': 'MY_DRIVE_DOCUMENT_PREVIEW_IMAGE',
                         'media-indexer': 'MY_DRIVE_INDEXER_IMAGE'}
            # Keep compose.yaml and host updater unit in sync even when migrating from older installs.
            compose_path = INSTALL / 'compose.yaml'
            before_compose = compose_path.read_text()
            model = json.loads(before_compose)
            ensure_updater_compose(model)
            ensure_lan_compose(model, candidate)
            after_compose = json.dumps(model, indent=2) + '\n'
            compose_changed = after_compose != before_compose
            if compose_changed:
                atomic(compose_path, after_compose)
            bundle_updated = False
            if args.source and source != INSTALL and (source / 'scripts').is_dir():
                for directory in ('scripts', 'docker'):
                    if (source / directory).is_dir():
                        shutil.copytree(source / directory, INSTALL / directory, dirs_exist_ok=True)
                for script in (INSTALL / 'scripts').glob('*.sh'):
                    script.chmod(0o700)
                bundle_updated = True
            elif 'app' in images:
                bundle_updated = extract_host_bundle(images['app'], INSTALL)
            if os.environ.get('MY_DRIVE_UPDATER_SUBPROCESS') != '1':
                install_updater_service(prepare_only=False, restart=True)
            elif bundle_updated:
                install_updater_service(prepare_only=True, restart=False)
            if all(state['env'].get(image_env[service]) == image for service, image in images.items()):
                if compose_changed:
                    print('phase: restarting Applying updated Compose configuration', flush=True)
                    start(state)
                    print('Compose configuration updated and verified.')
                else:
                    print('Already up to date; no services were restarted.')
                return
            atomic(INSTALL / 'state.previous.json', json.dumps(state, indent=2) + '\n')
            state['config']['images'] = candidate['images']
            for service, image in images.items():
                state['env'][image_env[service]] = image
            save(state)
            print('phase: restarting Restarting My Drive services and verifying health', flush=True)
            start(state)
            print('Updated and verified. Previous image references: /opt/my-drive/state.previous.json.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, StopIteration, EOFError, subprocess.CalledProcessError) as error:
        # Never print command arguments or configuration: they may contain secrets.
        print(f'Setup/operation failed ({type(error).__name__}).' + (f' {error}' if isinstance(error, ValueError) else ' Inspect my-drive status/logs and the deployment guide.'), file=sys.stderr)
        sys.exit(1)
