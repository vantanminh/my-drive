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
PATH_RE = re.compile(r'/[A-Za-z0-9_./-]+')
IMAGE_RE = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._:/@-]+')


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
               'min_free_gib', 'trash_days'}
    if set(config) - allowed:
        raise ValueError(f'unknown configuration fields: {sorted(set(config) - allowed)}')
    result = dict(config)
    result['host'] = valid_host(str(config['host']))
    if config.get('tls', 'acme') not in {'acme', 'internal'}:
        raise ValueError('tls must be acme or internal')
    result.setdefault('tls', 'acme')
    if result['tls'] == 'acme':
        try:
            ipaddress.IPv4Address(result['host'])
        except ValueError:
            pass
        else:
            raise ValueError('use internal TLS for IP-only installation')
    if not re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', str(config['email'])):
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
    tls = input('TLS: acme (public domain) / internal (own CA) [acme]: ').strip() or 'acme'
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


def prepare(config):
    # Validate all targets before creating or changing any data directory.
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
    services['app']['ports'] = []  # Only the TLS proxy is published.
    for service in services.values():
        service['logging'] = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}
    services['proxy'] = {
        'image': 'caddy:2-alpine', 'restart': 'unless-stopped',
        'ports': ['80:80', '443:443'],
        'volumes': [{'type': 'bind', 'source': str(INSTALL / 'Caddyfile'), 'target': '/etc/caddy/Caddyfile',
                     'read_only': True, 'bind': {'create_host_path': False}},
                    {'type': 'bind', 'source': str(INSTALL / 'caddy-data'), 'target': '/data',
                     'bind': {'create_host_path': False}},
                    {'type': 'bind', 'source': str(INSTALL / 'caddy-config'), 'target': '/config',
                     'bind': {'create_host_path': False}}],
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }
    return model


def caddyfile(config):
    global_options = '{\n    admin off\n' + (f"    email {config['email']}\n" if config['tls'] == 'acme' else '') + '}\n'
    tls = '    tls internal\n' if config['tls'] == 'internal' else ''
    return global_options + f"https://{config['host']} {{\n" + tls + '''    reverse_proxy app:3000
    header X-Content-Type-Options nosniff
}
'''


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
    # Validate HTTPS and readiness through the actual proxy, including TLS identity.
    args = ['curl', '--fail', '--silent', '--show-error', '--retry', '12', '--retry-delay', '5',
            '--retry-all-errors', '--max-time', '10', '--resolve', f"{state['config']['host']}:443:127.0.0.1"]
    if state['config']['tls'] == 'internal':
        root = INSTALL / 'caddy-data/caddy/pki/authorities/local/root.crt'
        for _ in range(30):
            if root.exists():
                break
            time.sleep(1)
        args += ['--cacert', str(root)]
    run(*args, f"https://{state['config']['host']}/health/ready")


def install(args):
    if (INSTALL / 'state.json').exists():
        print('Existing installation: resume with saved settings; no passwords or data are reset.')
        state = json.loads((INSTALL / 'state.json').read_text())
        if args.config:
            raise ValueError('existing installation: omit --config to resume; configuration is not overwritten')
    else:
        if INSTALL.exists() and any(INSTALL.iterdir()):
            raise ValueError(f'{INSTALL} is nonempty without installer state; refusing to overwrite')
        config = validate(json.loads(Path(args.config).read_text())) if args.config else ask(args.prebuilt)
        if args.prebuilt:
            if not config['images']:
                config['images'] = prebuilt_images(config, args.image_prefix, args.image_tag)
            config = validate(config)
        memory_kib = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                              if line.startswith('MemTotal:')))
        minimum = 2 if config['images'] else 4
        if memory_kib < minimum * 1024**2 * 0.95:
            raise ValueError(f'at least {minimum} GiB RAM required for this installation mode')
        for port in (80, 443):
            with socket.socket() as sock:
                sock.bind(('0.0.0.0', port))
        mounts = prepare(config)
        INSTALL.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(INSTALL, 0o700)
        images = build_images(config, SOURCE)
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
        write_env(INSTALL / '.env', values)
        atomic(INSTALL / 'owner-credentials.txt', f"URL: https://{config['host']}\nEmail: {config['email']}\nPassword: {config['owner_password']}\n")
        del config['owner_password']
        state = {'config': config, 'mounts': mounts, 'env': values}
        save(state)
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
    if not args.prepare_only:
        run('systemctl', 'enable', 'my-drive.service')
    return state


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    setup = sub.add_parser('install')
    setup.add_argument('--config', help='private JSON configuration; omit for wizard')
    setup.add_argument('--prepare-only', action='store_true', help='prepare files/images without starting or enabling service (recovery)')
    setup.add_argument('--prebuilt', action='store_true', help='download CI-published images; never build locally')
    setup.add_argument('--image-prefix', default='ghcr.io/vantanminh/my-drive')
    setup.add_argument('--image-tag', default='latest')
    for command in ('start', 'stop', 'status', 'check'):
        sub.add_parser(command)
    logs = sub.add_parser('logs')
    logs.add_argument('service', nargs='?', choices=['app', 'db', 'proxy', 'document-preview', 'media-indexer', 'media-indexer-db-setup'])
    for command in ('backup', 'update'):
        item = sub.add_parser(command)
        item.add_argument('--backup-root', required=True)
        item.add_argument('--recipient', required=True, help='age PUBLIC recipient (keep private identity offline)')
        if command == 'update':
            mode = item.add_mutually_exclusive_group(required=True)
            mode.add_argument('--source', help='reviewed checkout of the release to build; no automatic git pull')
            mode.add_argument('--images', help='JSON map of own registry image references for this release')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('run as root on Linux')
    os.umask(0o077)
    # Serialize install/start/update/backup so a reboot or second wizard cannot race secrets/config.
    import fcntl
    with open('/run/lock/my-drive-installer.lock', 'a') as lock:
        if args.command not in {'logs', 'status'}:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'install':
            state = install(args)
            if args.prepare_only:
                print('Prepared without starting/enabling the service. Complete recovery, then systemctl enable --now my-drive.')
                return
            # systemd starts a separate process, which must acquire this same lock.
            fcntl.flock(lock, fcntl.LOCK_UN)
            run('systemctl', 'restart', 'my-drive.service')
            print(f"Installed: https://{state['config']['host']}\nCredentials: /opt/my-drive/owner-credentials.txt (root only). Copy securely, then delete this file.")
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
            else:
                candidate['images'] = json.loads(Path(args.images).read_text())
                if not candidate['images']:
                    raise ValueError('--images must contain release image references')
            candidate = validate(candidate)
            images = build_images(candidate, source)  # Build/pull while old app remains available.
            backup(state, args)  # Mandatory complete encrypted backup before applying migrations.
            atomic(INSTALL / 'state.previous.json', json.dumps(state, indent=2) + '\n')
            state['config']['images'] = candidate['images']
            for service, image in images.items():
                key = {'app': 'MY_DRIVE_IMAGE', 'document-preview': 'MY_DRIVE_DOCUMENT_PREVIEW_IMAGE', 'media-indexer': 'MY_DRIVE_INDEXER_IMAGE'}[service]
                state['env'][key] = image
            save(state)
            start(state)
            print('Updated and verified. Previous image references: /opt/my-drive/state.previous.json. Database rollback requires restoring the backup.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, StopIteration, subprocess.CalledProcessError) as error:
        # Never print command arguments or configuration: they may contain secrets.
        print(f'Setup/operation failed ({type(error).__name__}).' + (f' {error}' if isinstance(error, ValueError) else ' Inspect my-drive status/logs and the deployment guide.'), file=sys.stderr)
        sys.exit(1)
