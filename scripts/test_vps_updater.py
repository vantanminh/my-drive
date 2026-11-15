#!/usr/bin/env python3
"""Unit tests for host updater helpers in scripts/vps.py."""
from __future__ import annotations

import pathlib
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
