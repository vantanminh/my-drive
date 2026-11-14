import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeServerUrl, probeServer, ServerUrlError } from '../src/services/serverUrl.ts';

test('normalizes public domain to https and preserves custom port', () => {
  const res = normalizeServerUrl('nas.example.com:8443/');
  assert.equal(res.url, 'https://nas.example.com:8443');
  assert.equal(res.isInsecureHttp, false);
  assert.equal(res.isLocalNetworkHost, false);
  assert.equal(res.wasAdjusted, true);
});

test('infers http for private LAN, .local mDNS, and Tailscale CGNAT hosts', () => {
  for (const input of ['192.168.1.50:8080', '10.0.0.12', '172.20.1.8:9000', '100.90.12.3:8080', 'mynas.local']) {
    const res = normalizeServerUrl(input);
    assert.ok(res.url.startsWith('http://'), `expected http for ${input}, got ${res.url}`);
    assert.equal(res.isInsecureHttp, true);
    assert.equal(res.isLocalNetworkHost, true);
  }
});

test('respects explicit https even on private LAN IP', () => {
  const res = normalizeServerUrl('https://192.168.1.50:8443');
  assert.equal(res.url, 'https://192.168.1.50:8443');
  assert.equal(res.isInsecureHttp, false);
  assert.equal(res.wasAdjusted, false);
});

test('strips pasted web UI route paths back to origin', () => {
  assert.equal(normalizeServerUrl('https://drive.myhome.dev/login').url, 'https://drive.myhome.dev');
  assert.equal(normalizeServerUrl('https://drive.myhome.dev/drive/folder/123?sort=name').url, 'https://drive.myhome.dev');
  assert.equal(normalizeServerUrl('http://192.168.1.10:8080/photos/').url, 'http://192.168.1.10:8080');
});

test('rejects invalid URLs, schemes, whitespace, and embedded credentials', () => {
  for (const bad of [
    '',
    '   ',
    'ftp://nas.local/files',
    'javascript:alert(1)',
    'https://user:secret@nas.example.com',
    'https://bad host name.com',
  ]) {
    assert.throws(() => normalizeServerUrl(bad), ServerUrlError, `expected rejection for "${bad}"`);
  }
});

test('probeServer validates /health/live and /.well-known/cloud-client capabilities', async () => {
  const calls: string[] = [];
  const res = await probeServer('https://nas.example.com/photos', async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/health/live')) {
      return new Response(JSON.stringify({ status: 'live' }), { status: 200 });
    }
    if (url.endsWith('/.well-known/cloud-client')) {
      return new Response(
        JSON.stringify({
          product: 'my-drive',
          apiVersion: '1',
          serverVersion: '0.1.0',
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
    }
    return new Response('not found', { status: 404 });
  });

  assert.deepEqual(calls, [
    'https://nas.example.com/health/live',
    'https://nas.example.com/.well-known/cloud-client',
  ]);
  assert.equal(res.normalizedUrl, 'https://nas.example.com');
  assert.equal(res.liveOk, true);
  assert.equal(res.capabilities?.serverVersion, '0.1.0');
  assert.equal(res.capabilities?.features.deduplication, true);
});

test('probeServer rejects unexpected server product or non-200 health check', async () => {
  await assert.rejects(
    () =>
      probeServer('https://other.example.com', async (input) => {
        if (String(input).endsWith('/health/live')) {
          return new Response('ok', { status: 200 });
        }
        return new Response(JSON.stringify({ product: 'nextcloud' }), { status: 200 });
      }),
    /Unexpected server product/,
  );

  await assert.rejects(
    () =>
      probeServer('https://down.example.com', async () => {
        return new Response('bad gateway', { status: 502 });
      }),
    /HTTP 502/,
  );
});
