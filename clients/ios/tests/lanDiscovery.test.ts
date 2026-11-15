import assert from 'node:assert/strict';
import test from 'node:test';

import { MyDriveClient } from '../src/services/apiClient.ts';
import {
  buildQuickLanCandidates,
  isLanHostname,
  isLanUrl,
  probeLanEndpoint,
  selectActiveEndpoint,
} from '../src/services/lanDiscovery.ts';

test('isLanHostname and isLanUrl distinguish physical LAN hosts from WAN and Tailscale', () => {
  assert.equal(isLanHostname('192.168.1.50'), true);
  assert.equal(isLanHostname('10.0.4.12'), true);
  assert.equal(isLanHostname('172.16.0.9'), true);
  assert.equal(isLanHostname('172.31.255.2'), true);
  assert.equal(isLanHostname('mydrive.local'), true);
  assert.equal(isLanHostname('nas.lan'), true);

  // Exclude Tailscale CGNAT (100.64.0.0/10), loopback, and public WAN hosts.
  assert.equal(isLanHostname('100.80.12.3'), false);
  assert.equal(isLanHostname('127.0.0.1'), false);
  assert.equal(isLanHostname('localhost'), false);
  assert.equal(isLanHostname('172.32.0.1'), false);
  assert.equal(isLanHostname('nas.example.com'), false);

  assert.equal(isLanUrl('http://192.168.1.50:3000'), true);
  assert.equal(isLanUrl('https://mydrive.local:8443'), true);
  assert.equal(isLanUrl('https://drive.example.com'), false);
  assert.equal(isLanUrl('http://100.90.10.2:3000'), false);
});

test('probeLanEndpoint verifies same serverId and rejects mismatched NAS identity', async () => {
  const fetchMock: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        product: 'my-drive',
        apiVersion: '1',
        serverVersion: '0.1.0',
        serverId: '11111111-1111-1111-1111-111111111111',
        features: {
          chunkedUpload: true,
          resumableUpload: true,
          deduplication: true,
          fileVersions: true,
          deviceAuthorization: true,
          contentHash: 'sha256',
        },
      }),
      { status: 200 },
    );

  const matched = await probeLanEndpoint('http://192.168.1.50:3000/', {
    expectedServerId: '11111111-1111-1111-1111-111111111111',
    fetchImpl: fetchMock,
  });
  assert.ok(matched);
  assert.equal(matched.url, 'http://192.168.1.50:3000');
  assert.equal(matched.matchedServerId, true);
  assert.ok(matched.latencyMs >= 1);

  const mismatched = await probeLanEndpoint('http://192.168.1.50:3000', {
    expectedServerId: '22222222-2222-2222-2222-222222222222',
    fetchImpl: fetchMock,
  });
  assert.equal(mismatched, null);
});

test('selectActiveEndpoint switches to LAN on Wi-Fi and falls back safely to remote', async () => {
  const serverId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const healthyFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        product: 'my-drive',
        apiVersion: '1',
        serverVersion: '0.1.0',
        serverId,
      }),
      { status: 200 },
    );

  const lanSelected = await selectActiveEndpoint({
    primaryUrl: 'https://nas.example.com',
    pairedLanUrl: 'http://192.168.1.50:3000',
    autoSwitchLan: true,
    expectedServerId: serverId,
    isConnected: true,
    isWifiOrEthernet: true,
    fetchImpl: healthyFetch,
  });
  assert.equal(lanSelected.mode, 'lan');
  assert.equal(lanSelected.activeUrl, 'http://192.168.1.50:3000');
  assert.equal(lanSelected.lanReachable, true);

  // Cellular / non-Wi-Fi stays on primary remote URL.
  const cellularSelected = await selectActiveEndpoint({
    primaryUrl: 'https://nas.example.com',
    pairedLanUrl: 'http://192.168.1.50:3000',
    autoSwitchLan: true,
    expectedServerId: serverId,
    isConnected: true,
    isWifiOrEthernet: false,
    fetchImpl: healthyFetch,
  });
  assert.equal(cellularSelected.mode, 'remote');
  assert.equal(cellularSelected.activeUrl, 'https://nas.example.com');

  // Auto-switch disabled stays on remote URL.
  const disabledSelected = await selectActiveEndpoint({
    primaryUrl: 'https://nas.example.com',
    pairedLanUrl: 'http://192.168.1.50:3000',
    autoSwitchLan: false,
    expectedServerId: serverId,
    isConnected: true,
    isWifiOrEthernet: true,
    fetchImpl: healthyFetch,
  });
  assert.equal(disabledSelected.mode, 'remote');
  assert.equal(disabledSelected.activeUrl, 'https://nas.example.com');

  // Unreachable LAN falls back to primary URL.
  const failingFetch: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const fallbackSelected = await selectActiveEndpoint({
    primaryUrl: 'https://nas.example.com',
    pairedLanUrl: 'http://192.168.1.50:3000',
    autoSwitchLan: true,
    expectedServerId: serverId,
    isConnected: true,
    isWifiOrEthernet: true,
    fetchImpl: failingFetch,
  });
  assert.equal(fallbackSelected.mode, 'remote');
  assert.equal(fallbackSelected.activeUrl, 'https://nas.example.com');
  assert.equal(fallbackSelected.lanReachable, false);

  // Offline marks mode = offline.
  const offlineSelected = await selectActiveEndpoint({
    primaryUrl: 'https://nas.example.com',
    pairedLanUrl: 'http://192.168.1.50:3000',
    autoSwitchLan: true,
    isConnected: false,
  });
  assert.equal(offlineSelected.mode, 'offline');
});

test('buildQuickLanCandidates prioritizes paired LAN URL and mDNS candidates', () => {
  const candidates = buildQuickLanCandidates({
    knownLanUrl: 'http://192.168.1.50:3000/',
    primaryServerUrl: 'https://nas.example.com:8443',
  });
  assert.equal(candidates[0], 'http://192.168.1.50:3000');
  assert.ok(candidates.includes('http://mydrive.local:3000'));
});

test('MyDriveClient sends mobile client header, captures session_token, and injects Bearer headers', async () => {
  const recorded: Array<{ url: string; auth: string | null; clientHeader: string | null }> = [];
  let updatedSessionToken: string | null = null;
  let transportErrorUrl: string | null = null;

  const client = new MyDriveClient({
    baseUrl: 'http://192.168.1.50:3000',
    onSessionTokenUpdate: (token) => {
      updatedSessionToken = token;
    },
    onTransportError: (failedUrl) => {
      transportErrorUrl = failedUrl;
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      recorded.push({
        url,
        auth: headers.get('Authorization'),
        clientHeader: headers.get('X-MyDrive-Client'),
      });
      if (url.endsWith('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            user: { id: 'u1', email: 'a@b.c', role: 'owner', must_change_password: false },
            csrf_token: 'csrf_1',
            session_token: 'mds_mobile_session_abc',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/auth/me')) {
        return new Response(
          JSON.stringify({ id: 'u1', email: 'a@b.c', role: 'owner', must_change_password: false }),
          { status: 200 },
        );
      }
      throw new Error('Network request failed');
    },
  });

  await client.login('a@b.c', 'password1234');
  assert.equal(updatedSessionToken, 'mds_mobile_session_abc');
  assert.equal(recorded[0].clientHeader, 'mobile');

  await client.me();
  assert.equal(recorded[1].auth, 'Bearer mds_mobile_session_abc');

  assert.deepEqual(client.thumbnailSource('f1'), {
    uri: 'http://192.168.1.50:3000/api/files/f1/thumbnail',
    headers: { Authorization: 'Bearer mds_mobile_session_abc' },
  });
  assert.deepEqual(client.previewSource('f1'), {
    uri: 'http://192.168.1.50:3000/api/files/f1/preview',
    headers: { Authorization: 'Bearer mds_mobile_session_abc' },
  });

  await assert.rejects(() => client.listTrash(), /Network request failed/);
  assert.equal(transportErrorUrl, 'http://192.168.1.50:3000');
});
