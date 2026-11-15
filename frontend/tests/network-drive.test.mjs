import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadApi() {
  let source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  source = source.replace(
    /^import\s+\{[^}]*\}\s+from\s+'react';\r?\n/m,
    'const useEffect = () => {}; const useState = (v) => [v, () => {}];\n'
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}

test('network drive API client sends WebDAV/SMB toggles and SMB password with CSRF', async () => {
  const { api } = await loadApi();
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'my_drive_csrf=csrf-smb' };

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        enabled: false,
        path: '/webdav/',
        lanOnly: true,
        readOnly: true,
        canManage: true,
        smbEnabled: true,
        smbAvailable: true,
        smbUsername: 'alice'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    await api.networkDriveStatus();
    await api.setNetworkDrive({ smbEnabled: true });
    await api.setSmbPassword('correct horse battery');

    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, '/api/network-drive');
    assert.equal(requests[0].options.method, 'GET');

    assert.equal(requests[1].url, '/api/network-drive');
    assert.equal(requests[1].options.method, 'PATCH');
    assert.equal(requests[1].options.headers.get('X-CSRF-Token'), 'csrf-smb');
    assert.deepEqual(JSON.parse(requests[1].options.body), { smbEnabled: true });

    assert.equal(requests[2].url, '/api/network-drive/smb-password');
    assert.equal(requests[2].options.method, 'PUT');
    assert.equal(requests[2].options.headers.get('X-CSRF-Token'), 'csrf-smb');
    assert.deepEqual(JSON.parse(requests[2].options.body), { password: 'correct horse battery' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
