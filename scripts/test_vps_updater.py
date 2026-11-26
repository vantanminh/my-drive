#!/usr/bin/env python3
"""Unit tests for host updater helpers in scripts/vps.py."""
from __future__ import annotations

import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import vps  # noqa: E402


class VpsUpdaterTests(unittest.TestCase):
    def test_apply_release_tag_updates_service_tags(self):
        images = {
            'app': 'ghcr.io/vantanminh/my-drive:latest',
            'document-preview': 'ghcr.io/vantanminh/my-drive-document-preview:latest',
            'media-indexer': 'ghcr.io/vantanminh/my-drive-indexer:sha-abcdef1',
        }
        tagged = vps.apply_release_tag(images, 'v0.1.3')
        self.assertEqual(tagged['app'], 'ghcr.io/vantanminh/my-drive:v0.1.3')
        self.assertEqual(tagged['document-preview'], 'ghcr.io/vantanminh/my-drive-document-preview:v0.1.3')
        self.assertEqual(tagged['media-indexer'], 'ghcr.io/vantanminh/my-drive-indexer:v0.1.3')

        with self.assertRaises(ValueError):
            vps.apply_release_tag(images, 'latest')
        with self.assertRaises(ValueError):
            vps.apply_release_tag({'app': 'ghcr.io/vantanminh/my-drive@sha256:' + 'a' * 64}, 'v0.1.3')

    def test_validate_backup_settings_enforces_safe_paths_and_public_age_keys(self):
        parsed = vps.validate_backup_settings(
            '/mnt/backup/my-drive',
            'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p',
        )
        self.assertEqual(parsed.backup_root, '/mnt/backup/my-drive')

        with self.assertRaises(ValueError):
            vps.validate_backup_settings('/', 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p')
        with self.assertRaises(ValueError):
            vps.validate_backup_settings('/mnt/../etc', 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p')
        with self.assertRaises(ValueError):
            vps.validate_backup_settings('/mnt/backup/my-drive', 'AGE-SECRET-KEY-1BAD')

    def test_ensure_updater_compose_is_idempotent(self):
        model = {'services': {'app': {'environment': {}, 'volumes': []}}}
        vps.ensure_updater_compose(model)
        vps.ensure_updater_compose(model)
        app = model['services']['app']
        self.assertEqual(app['environment']['MY_DRIVE_UPDATER_SOCKET'], '/run/my-drive-updater/updater.sock')
        self.assertEqual(len(app['volumes']), 1)
        self.assertEqual(app['volumes'][0]['target'], '/run/my-drive-updater')

    def test_updater_status_payload_omits_backup_requirement(self):
        payload = vps._updater_status_payload({'config': {'images': {'app': 'ghcr.io/vantanminh/my-drive:latest'}}})
        self.assertTrue(payload['connected'])
        self.assertEqual(payload['imageTrack'], 'ghcr.io/vantanminh/my-drive:latest')
        self.assertNotIn('backupConfigured', payload)
        self.assertNotIn('backupRootHint', payload)

    def test_ensure_lan_compose_enables_port_3000_for_cloudflare_without_clobbering_custom_ports(self):
        model = {'services': {'app': {'ports': []}}}
        vps.ensure_lan_compose(model, {'tls': 'cloudflare'})
        self.assertEqual(model['services']['app']['ports'], ['3000:3000'])

        # Respect existing custom ports unless force=True.
        custom = {'services': {'app': {'ports': ['192.168.0.151:3000:3000']}}}
        vps.ensure_lan_compose(custom, {'tls': 'cloudflare', 'lan_port': 3000})
        self.assertEqual(custom['services']['app']['ports'], ['192.168.0.151:3000:3000'])

        # Force mode updates bind IP / port or disables ports cleanly.
        vps.ensure_lan_compose(custom, {'tls': 'cloudflare', 'lan_enabled': True, 'lan_bind': '192.168.0.10', 'lan_port': 3001}, force=True)
        self.assertEqual(custom['services']['app']['ports'], ['192.168.0.10:3001:3000'])
        vps.ensure_lan_compose(custom, {'tls': 'cloudflare', 'lan_enabled': False}, force=True)
        self.assertEqual(custom['services']['app']['ports'], [])

        # ACME keeps app ports closed unless lan_enabled is explicitly True.
        acme = {'services': {'app': {'ports': []}}}
        vps.ensure_lan_compose(acme, {'tls': 'acme'})
        self.assertEqual(acme['services']['app']['ports'], [])
        vps.ensure_lan_compose(acme, {'tls': 'acme', 'lan_enabled': True, 'lan_port': 3000})
        self.assertEqual(acme['services']['app']['ports'], ['3000:3000'])

    def test_host_telemetry_parsers_handle_proc_meminfo_and_ndjson_ps(self):
        mem = vps.parse_proc_meminfo(
            'MemTotal:        8192000 kB\n'
            'MemFree:         1024000 kB\n'
            'MemAvailable:    4096000 kB\n'
            'SwapTotal:       2048000 kB\n'
            'SwapFree:        2048000 kB\n'
        )
        self.assertEqual(mem['memory']['totalBytes'], 8192000 * 1024)
        self.assertEqual(mem['memory']['availableBytes'], 4096000 * 1024)
        self.assertEqual(mem['memory']['usedBytes'], 4096000 * 1024)
        self.assertEqual(mem['swap']['usedBytes'], 0)

        services = vps.parse_compose_ps_json(
            '{"Name":"my-drive-app-1","Service":"app","State":"running","Health":"healthy","Status":"Up 2 hours","Image":"app:latest"}\n'
            '{"Name":"my-drive-proxy-1","Service":"proxy","State":"running","Health":"","Status":"Up 2 hours","Image":"caddy:2"}\n'
        )
        self.assertEqual(len(services), 2)
        self.assertEqual(services[0]['service'], 'app')
        self.assertEqual(services[0]['health'], 'healthy')
        self.assertIsNone(services[1]['health'])

    def test_netplan_yaml_and_ip_addr_parser_validate_physical_interfaces(self):
        parsed = vps.parse_ip_addr_json(
            '[{"ifname":"lo","operstate":"unknown","addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8}]},'
            '{"ifname":"br-124e8982","operstate":"up","addr_info":[{"family":"inet","local":"172.19.0.1","prefixlen":16}]},'
            '{"ifname":"enp2s0","operstate":"up","address":"74:d4:35:43:e1:1a","addr_info":[{"family":"inet","local":"192.168.0.151","prefixlen":24,"dynamic":true}]}]',
            '[{"dst":"default","gateway":"192.168.0.1","dev":"enp2s0"}]',
        )
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['name'], 'enp2s0')
        self.assertEqual(parsed[0]['ipv4'], ['192.168.0.151/24'])
        self.assertEqual(parsed[0]['gateway'], '192.168.0.1')
        self.assertTrue(parsed[0]['dhcp'])

        static_spec = vps.build_netplan_yaml('enp2s0', 'static', '192.168.0.151/24', '192.168.0.1', ['192.168.0.1', '1.1.1.1'])
        self.assertIn('dhcp4: false', static_spec['yaml'])
        self.assertIn('192.168.0.151/24', static_spec['yaml'])
        self.assertIn('via: 192.168.0.1', static_spec['yaml'])
        self.assertIn('addresses: [192.168.0.1, 1.1.1.1]', static_spec['yaml'])

        dhcp_spec = vps.build_netplan_yaml('enp2s0', 'dhcp')
        self.assertIn('dhcp4: true', dhcp_spec['yaml'])

        for bad_args in [
            ('docker0', 'dhcp', None, None),
            ('enp2s0', 'static', '192.168.0.0/24', '192.168.0.1'),
            ('enp2s0', 'static', 'not-an-ip', '192.168.0.1'),
            ('enp2s0', 'static', '192.168.0.151/24', 'bad-gw'),
        ]:
            with self.assertRaises(ValueError):
                vps.build_netplan_yaml(*bad_args)

    def test_ensure_smb_view_compose_moves_view_to_hdd_bind_idempotently(self):
        model = {
            'services': {
                'app': {'volumes': [{'type': 'volume', 'source': 'smb-view', 'target': '/srv/my-drive/smb-view'}]},
                'smb': {'volumes': [{'type': 'volume', 'source': 'smb-view', 'target': '/srv/view'}]},
            },
            'volumes': {'smb-view': {'name': 'my-drive_smb-view'}},
        }
        self.assertEqual(vps.legacy_smb_view_volume_name(model), 'my-drive_smb-view')
        self.assertTrue(vps.ensure_smb_view_compose(model))
        app_volume = model['services']['app']['volumes'][0]
        smb_volume = model['services']['smb']['volumes'][0]
        self.assertEqual(app_volume['type'], 'bind')
        self.assertEqual(app_volume['source'], '${STORAGE_DATA_HDD}/.smb-view')
        self.assertEqual(app_volume['target'], '/srv/my-drive/smb-view')
        self.assertEqual(smb_volume['source'], '${STORAGE_DATA_HDD}/.smb-view')
        self.assertEqual(smb_volume['target'], '/srv/view')
        self.assertEqual(model['services']['smb']['image'], '${MY_DRIVE_SMB_IMAGE:-ghcr.io/vantanminh/my-drive-smb:latest}')
        self.assertNotIn('smb-view', model['volumes'])
        self.assertIsNone(vps.legacy_smb_view_volume_name(model))
        self.assertFalse(vps.ensure_smb_view_compose(model))


    def test_smb_restart_uses_profile_only_when_it_was_running(self):
        with mock.patch.object(vps, 'compose') as compose:
            vps.restart_smb_after_update(False)
            compose.assert_not_called()
            vps.restart_smb_after_update(True)
            compose.assert_called_once_with('--profile', 'smb', 'up', '-d', 'smb')

    def test_build_rollout_docker_args_clones_network_alias_env_and_mounts(self):
        inspect = {
            'Config': {
                'Env': [
                    'DATABASE_URL=postgres://x',
                    'BOOTSTRAP_OWNER_PASSWORD=secret',
                    'COOKIE_SECURE=true',
                ]
            },
            'HostConfig': {'ReadonlyRootfs': False},
            'Mounts': [
                {'Type': 'bind', 'Source': '/mnt/hdd', 'Destination': '/srv/my-drive/data', 'RW': True},
                {'Type': 'bind', 'Source': '/mnt/ssd', 'Destination': '/srv/my-drive/previews', 'RW': False},
                {'Type': 'volume', 'Name': 'my-drive_smb-view', 'Destination': '/srv/my-drive/smb-view', 'RW': True},
            ],
            'NetworkSettings': {
                'Networks': {
                    'my-drive_default': {},
                    'my-drive_preview-private': {},
                }
            },
        }
        cmd, extra_nets = vps.build_rollout_docker_args(
            inspect,
            'ghcr.io/vantanminh/my-drive:v0.1.11',
            bind_overrides={'/srv/my-drive/smb-view': '/mnt/hdd/.smb-view'},
        )
        self.assertIn('--network-alias', cmd)
        self.assertIn('app', cmd)
        self.assertIn('my-drive_default', cmd)
        self.assertEqual(extra_nets, ['my-drive_preview-private'])
        self.assertIn('DATABASE_URL=postgres://x', cmd)
        self.assertNotIn('BOOTSTRAP_OWNER_PASSWORD=secret', cmd)
        self.assertIn('type=bind,source=/mnt/ssd,target=/srv/my-drive/previews,readonly', cmd)
        self.assertIn('type=bind,source=/mnt/hdd/.smb-view,target=/srv/my-drive/smb-view', cmd)
        self.assertEqual(cmd[-1], 'ghcr.io/vantanminh/my-drive:v0.1.11')


if __name__ == '__main__':
    unittest.main()
