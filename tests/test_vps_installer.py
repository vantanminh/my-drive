"""Installer invariants; Docker Compose interpolation test needs only its CLI."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vps', ROOT / 'scripts/vps.py')
vps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vps)


def compose_available():
    return bool(shutil.which('docker')) and subprocess.run(
        ['docker', 'compose', 'version'], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL).returncode == 0


class InstallerTests(unittest.TestCase):
    def config(self, **fields):
        config = json.loads((ROOT / 'deploy/vps.example.json').read_text())
        config.update(fields)
        return vps.validate(config)

    def test_rejects_injection_and_unsafe_config(self):
        for fields in [{'host': 'example.com {\n evil }'}, {'email': 'foo\nbar@example.com'},
                       {'storage': '/srv/../etc'}, {'storage': '/'}, {'storage': '/opt/my-drive/data'},
                       {'storage': '/srv/my-drive', 'database': '/srv/my-drive/postgres'},
                       {'quota_gib': True}, {'media_indexing': 'false'}, {'owner_password': 'short'},
                       {'unknown': True}, {'host': '192.0.2.1', 'tls': 'acme'},
                       {'images': {'app': 'foo:bar'}},
                       {'tls': 'acme-dns', 'cloudflare_api_token': 'short'},
                       {'tls': 'acme-dns', 'cloudflare_api_token': 'a' * 51},
                       {'tls': 'acme', 'cloudflare_api_token': 'a' * 40},
                       {'host': '192.0.2.1', 'tls': 'acme-dns', 'cloudflare_api_token': 'a' * 40},
                       {'tls': 'acme-dns', 'cloudflare_api_token': 'a' * 40, 'cloudflare_tunnel': True},
                       {'tls': 'acme-dns', 'cloudflare_api_token': 'a' * 40, 'cloudflare_tunnel_token': 'bad token'}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.config(**fields)

    def test_internal_ip_and_generated_password(self):
        config = self.config(host='192.0.2.1', tls='internal')
        self.assertGreaterEqual(len(config['owner_password']), 32)
        self.assertIn('tls internal', vps.caddyfile(config))
        self.assertNotIn('email ', vps.caddyfile(config))

    def test_mount_loss_is_fail_closed(self):
        state = {'config': {'storage': '/srv/my-drive/data'}, 'mounts': {
            'storage': {'uuid': 'data-disk', 'mount': '/srv'}}, 'env': {}}
        with patch.object(Path, 'is_dir', return_value=True), patch.object(vps, 'filesystem', return_value={
            'uuid': 'root-disk', 'mount': '/', 'device': '8:0'}), patch.object(vps, 'write_env') as write:
            with self.assertRaises(ValueError):
                vps.check(state)
            write.assert_not_called()

    def test_reboot_refreshes_device_only_after_uuid_check(self):
        state = {'config': {'storage': '/srv/data', 'previews': '/var/cache/previews'},
                 'mounts': {'storage': {'uuid': 'disk1', 'mount': '/srv'},
                            'previews': {'uuid': 'disk2', 'mount': '/'}}, 'env': {}}
        with patch.object(Path, 'is_dir', return_value=True), patch.object(vps, 'filesystem', side_effect=[
            {'uuid': 'disk1', 'mount': '/srv', 'device': '8:32'},
            {'uuid': 'disk2', 'mount': '/', 'device': '8:0'}]), patch.object(vps, 'write_env'):
            vps.check(state)
        self.assertEqual(state['env']['STORAGE_EXPECTED_DEVICE'], '8:32')

    def test_single_disk_keeps_backup_bind_but_disables_indexing(self):
        model = {'services': {'app': {'environment': {'MEDIA_PREVIEW_ROOT': '/preview', 'COOKIE_SECURE': 'true'},
                                     'ports': ['3000:3000'], 'volumes': ['preview-bind']},
                              'media-indexer': {}, 'media-indexer-db-setup': {}, 'db': {}}}
        actual = vps.make_compose(copy.deepcopy(model), self.config())
        self.assertNotIn('media-indexer', actual['services'])
        self.assertNotIn('MEDIA_PREVIEW_ROOT', actual['services']['app']['environment'])
        self.assertEqual(actual['services']['app']['ports'], [])
        self.assertEqual(actual['services']['app']['volumes'], ['preview-bind'])
        self.assertEqual(actual['services']['proxy']['ports'], ['80:80', '443:443'])

    def test_bootstrap_scrub_precedes_public_proxy(self):
        state = {'config': {'media_indexing': False, 'tls': 'acme', 'host': 'drive.example.com'},
                 'env': {'BOOTSTRAP_OWNER_EMAIL': 'owner@example.com', 'BOOTSTRAP_OWNER_PASSWORD': 'secret'}}
        calls = []
        with patch.object(vps, 'check'), patch.object(vps, 'wait_ready'), patch.object(vps, 'save'), \
             patch.object(vps, 'write_env'), patch.object(vps, 'run'), \
             patch.object(vps, 'compose', side_effect=lambda *args, **kw: calls.append(args)):
            vps.start(state)
        self.assertEqual(state['env']['BOOTSTRAP_OWNER_PASSWORD'], '')
        self.assertLess(calls.index(('up', '-d', '--force-recreate', 'app')), calls.index(('up', '-d')))

    def test_shell_cannot_override_private_compose_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / 'compose.yaml').write_text('${POSTGRES_PASSWORD:?required} ${MY_DRIVE_IMAGE}')
            with patch.object(vps, 'INSTALL', path), patch.dict(os.environ, {
                'POSTGRES_PASSWORD': 'unexpected', 'MY_DRIVE_IMAGE': 'unreviewed:image', 'COMPOSE_FILE': 'other.yaml'}):
                env = vps.compose_environment()
            self.assertNotIn('POSTGRES_PASSWORD', env)
            self.assertNotIn('MY_DRIVE_IMAGE', env)
            self.assertNotIn('COMPOSE_FILE', env)

    def test_prebuilt_install_pulls_and_pins_without_building(self):
        for indexing in (False, True):
            config = self.config(media_indexing=indexing)
            config['images'] = vps.prebuilt_images(config, 'ghcr.io/example/drive', 'v1.2.3')
            calls = []
            def command(*args, **kwargs):
                calls.append(args)
                return 'ghcr.io/example/artifact@sha256:' + 'a' * 64 if kwargs.get('capture') else None
            with patch.object(vps, 'run', side_effect=command):
                images = vps.build_images(config, Path('/no-source-required'))
            self.assertEqual(len(images), 3 if indexing else 2)
            self.assertTrue(all('@sha256:' in image for image in images.values()))
            self.assertFalse(any('build' in args for args in calls))
            self.assertEqual(sum(args[:2] == ('docker', 'pull') for args in calls), len(images))
            self.assertEqual(config['images']['document-preview'], 'ghcr.io/example/drive-document-preview:v1.2.3')

    def test_quick_connect_dns01_keeps_secrets_out_of_caddy_and_argv(self):
        token = 'a' * 40
        new_token = 'cfut_' + ('b' * 32)
        tunnel = ('A' * 20) + '+/=' + ('B' * 20)
        for api_token in (token, new_token):
            config = self.config(tls='acme-dns', cloudflare_api_token=api_token, cloudflare_tunnel_token=tunnel)
            self.assertTrue(config['cloudflare_tunnel'])
            caddy = vps.caddyfile(config)
            self.assertNotIn(api_token, caddy)
            self.assertNotIn(tunnel, caddy)
            self.assertIn('dns cloudflare {env.CLOUDFLARE_API_TOKEN}', caddy)
            self.assertIn('resolvers 1.1.1.1 1.0.0.1', caddy)
            self.assertIn('email owner@example.com', caddy)
            self.assertIn('https://drive.example.com', caddy)
        values = {}
        vps.persist_quick_connect(config, values)
        self.assertEqual(values['CLOUDFLARE_API_TOKEN'], new_token)
        self.assertEqual(values['CLOUDFLARE_TUNNEL_TOKEN'], tunnel)
        self.assertNotIn('cloudflare_api_token', config)
        self.assertNotIn('cloudflare_tunnel_token', config)
        saved = dict(config, owner_password='y' * 16)
        again = vps.validate(saved)
        self.assertTrue(again['cloudflare_tunnel'])
        self.assertNotIn('cloudflare_api_token', again)
        self.assertNotIn('cloudflare_tunnel_token', again)
        with tempfile.TemporaryDirectory() as temporary:
            env_file = Path(temporary) / '.env'
            vps.write_env(env_file, values)
            text = env_file.read_text()
            self.assertIn(json.dumps(new_token), text)
            self.assertIn(json.dumps(tunnel), text)
            self.assertNotIn('\n' + new_token, text)
        model = {'services': {
            'app': {'environment': {'COOKIE_SECURE': 'true'}, 'ports': ['3000:3000'],
                    'networks': ['default', 'preview-private']},
            'db': {'environment': {}},
            'document-preview': {'networks': ['preview-private']}},
                 'networks': {'preview-private': {'internal': True}}}
        actual = vps.make_compose(copy.deepcopy(model), config)
        proxy = actual['services']['proxy']
        self.assertEqual(proxy['image'], '${MY_DRIVE_CADDY_IMAGE}')
        self.assertEqual(proxy['environment']['CLOUDFLARE_API_TOKEN'], '${CLOUDFLARE_API_TOKEN}')
        self.assertEqual(proxy['ports'], ['80:80', '443:443'])
        self.assertEqual(actual['services']['app']['environment']['COOKIE_SECURE'], 'true')
        cloudflared = actual['services']['cloudflared']
        self.assertEqual(cloudflared['image'], vps.CLOUDFLARED_IMAGE)
        self.assertEqual(cloudflared['command'], ['tunnel', '--no-autoupdate', 'run'])
        self.assertNotIn(tunnel, cloudflared['command'])
        self.assertEqual(cloudflared['environment']['TUNNEL_TOKEN'], '${CLOUDFLARE_TUNNEL_TOKEN}')
        self.assertEqual(cloudflared['networks'], ['quick-connect'])
        self.assertIn('quick-connect', actual['services']['app']['networks'])
        self.assertNotIn('quick-connect', actual['services']['db'].get('networks', []))
        self.assertNotIn('quick-connect', actual['services']['document-preview']['networks'])
        self.assertIn('quick-connect', actual['networks'])

        direct = self.config(tls='acme-dns', cloudflare_api_token=token, cloudflare_tunnel_token='')
        self.assertFalse(direct['cloudflare_tunnel'])
        self.assertNotIn('cloudflare_tunnel_token', direct)
        direct_model = vps.make_compose(copy.deepcopy(model), direct)
        self.assertNotIn('cloudflared', direct_model['services'])
        self.assertNotIn('quick-connect', direct_model['services']['app']['networks'])

        plain_config = self.config()
        plain = vps.make_compose(copy.deepcopy(model), plain_config)
        self.assertEqual(plain['services']['proxy']['image'], 'caddy:2-alpine')
        self.assertNotIn('environment', plain['services']['proxy'])
        self.assertNotIn('cloudflared', plain['services'])
        self.assertNotIn('dns cloudflare', vps.caddyfile(plain_config))

        sealed = {key: value for key, value in direct.items() if key != 'cloudflare_api_token'}
        sealed['owner_password'] = 'x' * 16
        revalidated = vps.validate(sealed)
        self.assertNotIn('cloudflare_api_token', revalidated)
        self.assertFalse(revalidated['cloudflare_tunnel'])
        with self.assertRaises(ValueError):
            vps.persist_quick_connect(revalidated, {})

        images = vps.prebuilt_images(self.config(tls='acme-dns', cloudflare_api_token=token),
                                     'ghcr.io/example/drive', 'v1.2.3')
        self.assertEqual(images['caddy'], 'ghcr.io/example/drive-caddy:v1.2.3')
        self.assertNotIn('caddy', vps.prebuilt_images(self.config(), 'ghcr.io/example/drive', 'v1.2.3'))
        caddy_ref = 'registry.example.com/caddy:1'
        accepted = self.config(tls='acme-dns', cloudflare_api_token=token, images={
            'app': 'registry.example.com/app:1', 'document-preview': 'registry.example.com/doc:1', 'caddy': caddy_ref})
        self.assertEqual(accepted['images']['caddy'], caddy_ref)

    @unittest.skipUnless(compose_available(), 'Docker Compose CLI is not available')
    def test_quick_connect_compose_resolves_secrets_without_exposing_the_database(self):
        token = 'd' * 40
        tunnel = ('E' * 40) + '+/='
        config = self.config(tls='acme-dns', cloudflare_api_token=token, cloudflare_tunnel_token=tunnel)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for directory in ('db', 'storage', 'previews', 'caddy-data', 'caddy-config'):
                (path / directory).mkdir()
            values = {
                'POSTGRES_PASSWORD': 'a' * 64, 'MEDIA_INDEXER_PASSWORD': 'b' * 64,
                'POSTGRES_DATA_SSD': str(path / 'db'), 'STORAGE_DATA_HDD': str(path / 'storage'),
                'MEDIA_PREVIEW_DATA_SSD': str(path / 'previews'), 'STORAGE_EXPECTED_DEVICE': '8:1',
                'MEDIA_PREVIEW_EXPECTED_DEVICE': '8:2', 'BOOTSTRAP_OWNER_PASSWORD': 'p' * 16,
                'BOOTSTRAP_OWNER_EMAIL': 'owner@example.com', 'MY_DRIVE_IMAGE': 'own-app:test',
                'MY_DRIVE_DOCUMENT_PREVIEW_IMAGE': 'own-doc:test', 'MY_DRIVE_INDEXER_IMAGE': 'own-index:test',
                'MY_DRIVE_CADDY_IMAGE': 'own-caddy:test'}
            vps.persist_quick_connect(config, values)
            vps.write_env(path / '.env', values)
            clean = {key: value for key, value in os.environ.items() if key not in values}
            raw = json.loads(subprocess.check_output([
                'docker', 'compose', '--env-file', str(path / '.env'), '-f', str(ROOT / 'compose.yaml'),
                'config', '--format', 'json', '--no-interpolate', '--no-path-resolution'], text=True, env=clean))
            with patch.object(vps, 'INSTALL', path):
                generated = vps.make_compose(raw, config)
            target = path / 'compose.yaml'
            target.write_text(json.dumps(generated))
            resolved = json.loads(subprocess.check_output([
                'docker', 'compose', '--env-file', str(path / '.env'), '-f', str(target),
                'config', '--format', 'json'], text=True, env=clean))
        proxy = resolved['services']['proxy']
        cloudflared = resolved['services']['cloudflared']
        self.assertEqual(proxy['image'], 'own-caddy:test')
        self.assertEqual(proxy['environment']['CLOUDFLARE_API_TOKEN'], token)
        self.assertEqual(cloudflared['environment']['TUNNEL_TOKEN'], tunnel)
        command = cloudflared['command']
        if isinstance(command, str):
            self.assertNotIn(tunnel, command)
        else:
            self.assertNotIn(tunnel, command)
            self.assertNotIn('--token', command)
        self.assertIn('quick-connect', cloudflared['networks'])
        self.assertIn('quick-connect', resolved['services']['app']['networks'])
        self.assertNotIn('quick-connect', resolved['services']['db'].get('networks') or {})

    def test_local_caddy_build_does_not_receive_cloudflare_token(self):
        token = 'c' * 40
        config = self.config(tls='acme-dns', cloudflare_api_token=token)
        calls = []

        def command(*args, **kwargs):
            calls.append(args)
            return None

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            dockerfile = source / 'docker/caddy/Dockerfile'
            dockerfile.parent.mkdir(parents=True)
            dockerfile.write_text('FROM scratch\n')
            with patch.object(vps, 'run', side_effect=command):
                images = vps.build_images(config, source)
        self.assertTrue(images['caddy'].startswith('my-drive-local-caddy:'))
        flat = ' '.join(str(part) for args in calls for part in args)
        self.assertNotIn(token, flat)
        self.assertIn(str(dockerfile), flat)

    def test_prebuilt_reference_validation(self):
        for prefix, tag in [('https://registry/drive', 'latest'), ('ghcr.io/example/drive', 'tag;command')]:
            with self.assertRaises(ValueError):
                vps.prebuilt_images(self.config(), prefix, tag)

    @unittest.skipUnless(compose_available(), 'Docker Compose CLI is not available')
    def test_password_edge_cases_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            model = {'services': {'app': {'image': 'busybox:latest', 'environment': {'PASSWORD': '${PASSWORD}'}}}}
            target = path / 'compose.yaml'
            target.write_text(json.dumps(model))
            for password in ["longpasswordendswith\\", "longpassword\\'quote", '${HOME} literal # value',
                             'longpassword"quoted"', 'longpassword\\\\tail']:
                with self.subTest(password=password):
                    vps.write_env(path / '.env', {'PASSWORD': password})
                    clean = {key: value for key, value in os.environ.items() if key != 'PASSWORD'}
                    result = json.loads(subprocess.check_output(['docker', 'compose', '--env-file', str(path / '.env'),
                        '-f', str(target), 'config', '--format', 'json'], text=True, env=clean))
                    self.assertEqual(result['services']['app']['environment']['PASSWORD'], password.replace('$', '$$'))

    @unittest.skipUnless(compose_available(), 'Docker Compose CLI is not available')
    def test_real_compose_literal_secrets_and_generated_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            env = path / '.env'
            password = "pA$$word# with 'quotes' and \\backslash"
            vps.write_env(env, {'POSTGRES_PASSWORD': 'a' * 64, 'MEDIA_INDEXER_PASSWORD': 'b' * 64,
                'POSTGRES_DATA_SSD': str(path / 'db'), 'STORAGE_DATA_HDD': str(path / 'storage'),
                'MEDIA_PREVIEW_DATA_SSD': str(path / 'previews'), 'STORAGE_EXPECTED_DEVICE': '8:1',
                'MEDIA_PREVIEW_EXPECTED_DEVICE': '8:2', 'BOOTSTRAP_OWNER_PASSWORD': password,
                'BOOTSTRAP_OWNER_EMAIL': 'owner@example.com', 'MY_DRIVE_IMAGE': 'own-app:test',
                'MY_DRIVE_DOCUMENT_PREVIEW_IMAGE': 'own-doc:test', 'MY_DRIVE_INDEXER_IMAGE': 'own-index:test'})
            def config(file, *extra):
                # Clear inherited env so workstation secrets cannot enter the fixture.
                clean = {key: value for key, value in os.environ.items() if key not in {
                    'BOOTSTRAP_OWNER_PASSWORD', 'MY_DRIVE_IMAGE', 'POSTGRES_PASSWORD'}}
                return json.loads(subprocess.check_output(['docker', 'compose', '--env-file', str(env),
                    '-f', str(file), 'config', '--format', 'json', *extra], text=True, env=clean))
            raw = config(ROOT / 'compose.yaml', '--no-interpolate', '--no-path-resolution')
            for indexing in (False, True):
                generated = vps.make_compose(copy.deepcopy(raw), self.config(media_indexing=indexing))
                target = path / 'compose.yaml'
                target.write_text(json.dumps(generated))
                resolved = config(target)
                app = resolved['services']['app']
                self.assertEqual(app['image'], 'own-app:test')
                # `compose config` escapes $ again so its output can be reused as a Compose file.
                self.assertEqual(app['environment']['BOOTSTRAP_OWNER_PASSWORD'], password.replace('$', '$$'))
                self.assertTrue(app['environment']['STORAGE_REQUIRE_DEVICE_MATCH'] == 'true')
                self.assertFalse(app.get('ports'))
                self.assertEqual('MEDIA_PREVIEW_ROOT' in app['environment'], indexing)
                storage = next(item for item in app['volumes'] if item['target'] == '/srv/my-drive/data')
                self.assertEqual(Path(storage['source']), path / 'storage')


if __name__ == '__main__':
    unittest.main()
