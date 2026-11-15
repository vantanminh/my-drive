import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTsModule(relativePath) {
  let source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  source = source.replace(
    /^import\s+\{[^}]*\}\s+from\s+'react';\r?\n/m,
    'const useEffect = () => {}; const useState = (v) => [v, () => {}];\n'
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}

test('route parser and builder support the owner updates panel', async () => {
  const { parseDriveRoute, buildDrivePath } = await loadTsModule('../src/route.ts');
  const parsed = parseDriveRoute('/updates');
  assert.equal(parsed.panel, 'updates');
  assert.equal(parsed.section, 'drive');
  assert.equal(buildDrivePath(parsed, []), '/updates');
  assert.equal(parseDriveRoute('/drive', '?panel=updates').panel, 'updates');
});

test('system update API client sends CSRF, JSON, and credentials', async () => {
  const { api } = await loadTsModule('../src/api.ts');
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'my_drive_csrf=csrf-123' };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await api.checkForUpdates();
    await api.updateUpdateSettings({
      autoCheckEnabled: true,
      autoUpdateEnabled: false,
      checkIntervalMinutes: 60
    });
    await api.applySystemUpdate('v0.2.0');

    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, '/api/admin/updates/check');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.get('X-CSRF-Token'), 'csrf-123');

    assert.equal(requests[1].url, '/api/admin/updates/settings');
    assert.equal(requests[1].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      autoCheckEnabled: true,
      autoUpdateEnabled: false,
      checkIntervalMinutes: 60
    });

    assert.equal(requests[2].url, '/api/admin/updates/apply');
    assert.deepEqual(JSON.parse(requests[2].options.body), { targetTag: 'v0.2.0' });

    await api.hostOverview();
    await api.restartHostService('app');
    await api.hostServiceLogs('updater', 50);

    assert.equal(requests.length, 6);
    assert.equal(requests[3].url, '/api/admin/host/overview');
    assert.equal(requests[4].url, '/api/admin/host/services/restart');
    assert.equal(requests[4].options.method, 'POST');
    assert.equal(requests[4].options.headers.get('X-CSRF-Token'), 'csrf-123');
    assert.deepEqual(JSON.parse(requests[4].options.body), { service: 'app' });
    assert.equal(requests[5].url, '/api/admin/host/services/logs?service=updater&tail=50');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
