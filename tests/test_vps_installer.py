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
                       {'images': {'app': 'foo:bar'}}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.config(**fields)

    def test_tls_aliases_from_wizard_answers(self):
        self.assertEqual(self.config(tls='unencrypted')['tls'], 'http')
        self.assertEqual(self.config(tls=' HTTPS ')['tls'], 'acme')
        with self.assertRaises(ValueError):
            self.config(tls='ftp')

    def test_web_wizard_requires_token_loopback_host_and_json(self):
        import http.client, sys
        sys.path.insert(0, str(ROOT / 'scripts'))
        import setup_web
        preflight = patch.object(vps, 'preflight', return_value={})
        preflight.start()
        self.addCleanup(preflight.stop)
        with patch('builtins.print'):
            wizard = setup_web.serve(vps, True, '127.0.0.1', 0)
        port = wizard.server.server_address[1]
        try:
            def request(method, path, body=None, headers=None):
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                conn.request(method, path, body, headers or {})
                response = conn.getresponse()
                return response.status, response.getheader('Set-Cookie'), response.read()
            self.assertEqual(request('GET', '/')[0], 403)
            self.assertEqual(request('GET', '/?token=wrong')[0], 403)
            self.assertEqual(request('GET', '/api/system')[0], 403)
            status, cookie, _ = request('GET', f'/?token={wizard.token}')
            self.assertEqual(status, 303)
            self.assertIn('HttpOnly', cookie)
            auth = {'Cookie': cookie.split(';')[0]}
            self.assertEqual(request('GET', '/', headers=auth)[0], 200)
            self.assertEqual(request('GET', '/', headers=dict(auth, Host=f'evil.example:{port}'))[0], 421)
            config = json.loads((ROOT / 'deploy/vps.example.json').read_text())
            body = json.dumps({'config': dict(config, tls='http')})
            self.assertEqual(request('POST', '/api/install', body, auth)[0], 415)
            json_auth = dict(auth, **{'Content-Type': 'application/json'})
            self.assertEqual(request('POST', '/api/install', body, dict(json_auth, Origin='http://evil.example'))[0], 403)
            bad = json.dumps({'config': dict(config, host='https://x/')})
            self.assertEqual(request('POST', '/api/check', bad, json_auth)[0], 400)
            self.assertEqual(request('POST', '/api/install', body, json_auth)[0], 202)
            self.assertTrue(wizard.submitted.is_set())
            self.assertEqual(wizard.config['tls'], 'http')
            self.assertGreaterEqual(len(wizard.config['owner_password']), 32)
            self.assertEqual(request('POST', '/api/install', body, json_auth)[0], 400)
            wizard.progress('step one')
            wizard.done('http://drive.example.com', 'pw')
            status, _, data = request('GET', '/api/status', headers=auth)
            self.assertEqual(json.loads(data)['phase'], 'done')
        finally:
            wizard.server.shutdown()

    def test_cloudflare_tunnel_mode(self):
        token = 'a' * 40
        config = self.config(tls='tunnel', cf_token=token, cf_replicas=3)
        self.assertEqual((config['tls'], config['cf_replicas'], config['cf_token']), ('cloudflare', 3, token))
        for fields in [{'tls': 'cloudflare', 'host': '192.0.2.1'}, {'tls': 'cloudflare', 'cf_replicas': 9},
                       {'tls': 'cloudflare', 'cf_token': 'bad token'}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.config(**fields)
        self.assertNotIn('cf_replicas', self.config(cf_replicas=3))  # ignored outside tunnel mode
        caddy = vps.caddyfile(config)
        self.assertIn('http://drive.example.com {', caddy)
        self.assertIn('auto_https off', caddy)
        model = vps.make_compose({'services': {'app': {'environment': {}}}}, config)
        self.assertEqual(model['services']['proxy']['ports'], ['127.0.0.1:80:80'])
        connector = model['services']['cloudflared']
        self.assertEqual(connector['deploy']['replicas'], 3)
        self.assertIn('${CLOUDFLARE_TUNNEL_TOKEN', connector['environment']['TUNNEL_TOKEN'])
        self.assertEqual(model['services']['app']['environment']['COOKIE_SECURE'], 'true')

    def test_cloudflare_provision_routes_dns_and_reuses_tunnel(self):
        cloudflare = vps.local_module('cloudflare')
        calls = []
        zone = {'id': 'z1', 'name': 'example.com', 'status': 'active', 'account': {'id': 'acc', 'name': 'Me'}}

        def fake(token, method, path, body=None, query=None):
            calls.append((method, path, body))
            if path == '/zones':
                return [zone] if query['name'] == 'example.com' else []
            if path.endswith('/cfd_tunnel') and method == 'GET':
                return []
            if path.endswith('/cfd_tunnel'):
                return {'id': 't1', 'name': body['name']}
            if path.endswith('/token'):
                return 'connector-token'
            if path.endswith('/dns_records') and method == 'GET':
                return [{'id': 'r1', 'type': 'A', 'content': '198.51.100.7'}]
            return {}
        with patch.object(cloudflare, 'api', side_effect=fake):
            result = cloudflare.provision('a' * 40, 'drive.example.com')
        self.assertEqual(result['connector_token'], 'connector-token')
        ingress = next(b for m, p, b in calls if p.endswith('/configurations'))['config']['ingress']
        self.assertEqual(ingress[0], {'hostname': 'drive.example.com', 'service': 'http://proxy:80',
                                      'originRequest': {'httpHostHeader': 'drive.example.com', 'connectTimeout': 30}})
        self.assertEqual(ingress[-1], {'service': 'http_status:404'})
        self.assertIn(('DELETE', '/zones/z1/dns_records/r1', None), calls)
        cname = next(b for m, p, b in calls if m == 'POST' and p == '/zones/z1/dns_records')
        self.assertEqual((cname['type'], cname['content'], cname['proxied']), ('CNAME', 't1.cfargotunnel.com', True))

    def test_cloudflare_rejects_records_that_cannot_coexist(self):
        cloudflare = vps.local_module('cloudflare')
        zone = {'id': 'z1', 'name': 'example.com', 'status': 'active', 'account': {'id': 'acc'}}

        def fake(token, method, path, body=None, query=None):
            if path == '/zones':
                return [zone]
            if path.endswith('/dns_records'):
                return [{'id': 'r', 'type': 'MX', 'content': 'mail.example.com'}]
            return []
        with patch.object(cloudflare, 'api', side_effect=fake), self.assertRaises(ValueError):
            cloudflare.inspect('a' * 40, 'example.com')

    def test_web_wizard_lan_mode_accepts_only_private_networks(self):
        import http.client, sys
        sys.path.insert(0, str(ROOT / 'scripts'))
        import setup_web
        for address, private in [('192.168.1.20', True), ('10.0.0.5', True), ('172.16.3.4', True),
                                 ('127.0.0.1', True), ('fe80::1', True), ('fd00::2', True),
                                 ('::ffff:192.168.1.2', True), ('8.8.8.8', False), ('100.64.0.1', False),
                                 ('2606:4700::1', False), ('example.com', False)]:
            with self.subTest(address=address):
                self.assertEqual(setup_web.private_client(address), private)
        with patch('builtins.print'), patch.object(setup_web, 'lan_addresses', return_value=['192.168.1.10']):
            wizard = setup_web.serve(vps, True, '0.0.0.0', 0)
        port = wizard.server.server_address[1]
        try:
            def get(path, host):
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                conn.request('GET', path, headers={'Host': host})
                response = conn.getresponse()
                response.read()
                return response.status
            self.assertEqual(get(f'/?token={wizard.token}', f'192.168.1.10:{port}'), 303)
            self.assertEqual(get('/', f'192.168.1.10:{port}'), 403)  # token still required
            self.assertEqual(get(f'/?token={wizard.token}', f'drive.example.com:{port}'), 421)
            self.assertEqual(get(f'/?token={wizard.token}', f'8.8.8.8:{port}'), 421)
        finally:
            wizard.server.shutdown()

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
