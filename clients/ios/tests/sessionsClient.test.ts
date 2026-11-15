import assert from 'node:assert/strict';
import test from 'node:test';

import { MyDriveClient } from '../src/services/apiClient';

test('mobile client sends device label and can revoke individual sessions', async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const client = new MyDriveClient({
    baseUrl: 'https://nas.example.com',
    csrfToken: 'csrf-123',
    sessionToken: 'mds_token_abc',
    deviceLabel: 'MyDrive iPhone 16',
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
      });
      if (String(input).endsWith('/api/auth/mobile-token')) {
        return new Response(JSON.stringify({ session_token: 'mds_rotated' }), { status: 200 });
      }
      if (String(input).endsWith('/api/auth/sessions')) {
        return new Response(
          JSON.stringify([
            {
              id: 's1',
              created_at: '2026-01-01T00:00:00Z',
              last_seen_at: '2026-01-01T00:05:00Z',
              expires_at: '2026-01-08T00:00:00Z',
              is_current: true,
              ip_address: '192.168.0.25',
              client_type: 'mobile',
              device_label: 'MyDrive iPhone 16',
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    },
  });

  await client.issueMobileSessionToken();
  const sessions = await client.listSessions();
  await client.revokeSession('sess-other');

  assert.equal(requests[0]?.headers['x-mydrive-client'], 'mobile');
  assert.equal(requests[0]?.headers['x-mydrive-device'], 'MyDrive iPhone 16');
  assert.equal(sessions[0]?.ip_address, '192.168.0.25');
  assert.equal(requests[2]?.method, 'DELETE');
  assert.equal(requests[2]?.url, 'https://nas.example.com/api/auth/sessions/sess-other');
  assert.equal(requests[2]?.headers['x-csrf-token'], 'csrf-123');
});
