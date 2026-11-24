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

test('route parser and builder support the settings hub panels', async () => {
  const { parseDriveRoute, buildDrivePath } = await loadTsModule('../src/route.ts');
  const parsed = parseDriveRoute('/updates');
  assert.equal(parsed.panel, 'updates');
  assert.equal(parsed.section, 'settings');
  assert.equal(buildDrivePath(parsed, []), '/settings/updates');
  assert.equal(parseDriveRoute('/settings/updates').panel, 'updates');
  assert.equal(parseDriveRoute('/drive', '?panel=updates').panel, 'updates');
  assert.equal(parseDriveRoute('/drive', '?panel=updates').section, 'settings');

  const teamsParsed = parseDriveRoute('/teams');
  assert.equal(teamsParsed.panel, 'teams');
  assert.equal(teamsParsed.section, 'settings');
  assert.equal(buildDrivePath(teamsParsed, []), '/settings/teams');
  assert.equal(parseDriveRoute('/drive', '?panel=teams').panel, 'teams');
  assert.equal(parseDriveRoute('/settings').section, 'settings');
  assert.equal(parseDriveRoute('/settings').panel, null);
  assert.equal(buildDrivePath(parseDriveRoute('/settings'), []), '/settings');
});

test('teams API client scopes workspace requests and URL builders cleanly', async () => {
  const { api, setActiveTeamWorkspace, downloadUrl, previewUrl, thumbnailUrl } = await loadTsModule('../src/api.ts');
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
    await api.listTeams();
    await api.createTeam({ name: 'Design', description: 'Assets', quotaBytes: 1024 });
    await api.addTeamMember('team-1', { email: 'alice@example.com', role: 'admin' });
    await api.deleteManagedAccount('user-2');

    setActiveTeamWorkspace('team-1');
    await api.listDrive(null);
    await api.accountStorage();

    assert.equal(requests[0].url, '/api/teams');
    assert.equal(requests[1].url, '/api/teams');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[2].url, '/api/teams/team-1/members');
    assert.equal(requests[3].url, '/api/admin/accounts/user-2');
    assert.equal(requests[3].options.method, 'DELETE');
    assert.equal(requests[4].options.headers.get('X-MyDrive-Team'), 'team-1');
    assert.equal(requests[5].options.headers.get('X-MyDrive-Team'), 'team-1');
    assert.equal(downloadUrl('f1'), '/api/files/f1/download?team_id=team-1');
    assert.equal(previewUrl('f1'), '/api/files/f1/preview?team_id=team-1');
    assert.equal(thumbnailUrl('f1'), '/api/files/f1/thumbnail?team_id=team-1');

    setActiveTeamWorkspace(null);
    assert.equal(downloadUrl('f1'), '/api/files/f1/download');
  } finally {
    setActiveTeamWorkspace(null);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
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

    await api.hostNetwork();
    await api.updateHostLan({ enabled: true, port: 3000, bind: '', configureUfw: true });
    await api.applyHostNetplan({
      interface: 'enp2s0',
      mode: 'static',
      addressCidr: '192.168.0.151/24',
      gateway: '192.168.0.1',
      dns: ['192.168.0.1', '1.1.1.1'],
      confirmTimeoutSeconds: 90
    });
    await api.confirmHostNetplan();
    await api.rollbackHostNetplan();

    assert.equal(requests.length, 11);
    assert.equal(requests[6].url, '/api/admin/host/network');
    assert.equal(requests[7].url, '/api/admin/host/network/lan');
    assert.equal(requests[8].url, '/api/admin/host/network/netplan');
    assert.equal(requests[9].url, '/api/admin/host/network/confirm');
    assert.equal(requests[10].url, '/api/admin/host/network/rollback');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
