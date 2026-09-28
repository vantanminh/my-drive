import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('Google Drive settings save sends JSON, CSRF and session credentials', async () => {
  const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  const { api } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'my_drive_csrf=test-csrf-token' };
  const settings = {
    client_id: 'test-client.apps.googleusercontent.com',
    client_secret: 'test-secret',
    redirect_uri: 'https://drive.example.test/api/google-drive/callback'
  };
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, '/api/google-drive/settings');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.headers.get('X-CSRF-Token'), 'test-csrf-token');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(JSON.parse(options.body), settings);
    return new Response(null, { status: 204 });
  };
  try {
    assert.equal(await api.googleDriveSaveSettings(settings), undefined);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
