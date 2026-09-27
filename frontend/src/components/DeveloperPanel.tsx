import { useEffect, useState } from 'react';
import { request } from '../api';
import type { User } from '../types';

type Key = { id: string; name: string; prefix: string; scopes: string[]; revoked_at: string | null; expires_at: string | null; last_used_at: string | null };
type Day = { day: string; requests: number; errors: number; request_bytes: number; avg_duration_ms: number };
type Usage = { daily: Day[]; users: { owner_id: string; email: string; requests: number; errors: number; request_bytes: number }[] };
type Log = { id: number; api_key_id: string; owner_id: string; method: string; route: string; status: number; duration_ms: number; request_bytes: number; created_at: string };
const scopes = ['drive:read', 'drive:write', 'photos:read', 'photos:write', 'shares:read', 'shares:write'];
export default function DeveloperPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [nextKeyOffset, setNextKeyOffset] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage>({ daily: [], users: [] });
  const [logs, setLogs] = useState<Log[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(scopes);
  const [expiry, setExpiry] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [filterKey, setFilterKey] = useState('');
  const [days, setDays] = useState(30);
  const [refresh, setRefresh] = useState(0);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const [revokeShares, setRevokeShares] = useState(false);
  const [sharesOnly, setSharesOnly] = useState(false);
  const [notice, setNotice] = useState('');
  const query = `?all=${all}&days=${days}${filterKey ? '&key_id=' + encodeURIComponent(filterKey) : ''}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    Promise.all([
      request<{ keys: Key[]; next_offset: number | null }>('/api/developer/keys', { signal: controller.signal }),
      request<Usage>('/api/developer/usage' + query, { signal: controller.signal }),
      request<{ logs: Log[]; next_before_id: number | null }>('/api/developer/logs' + query, { signal: controller.signal })
    ]).then(([k, u, l]) => { setKeys(k.keys); setNextKeyOffset(k.next_offset); setUsage(u); setLogs(l.logs); setNext(l.next_before_id); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [query, refresh]);
  async function action(work: () => Promise<void>, reload = true) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); if (reload) setRefresh(v => v + 1); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setBusy(false); }
  }
  const total = usage.daily.reduce((s, d) => s + Number(d.requests), 0);
  const peak = Math.max(1, ...usage.daily.map(d => Number(d.requests)));
  return <section className="developer-panel" aria-labelledby="developer-title">
    <div className="developer-heading"><div><small>SETTINGS</small><h2 id="developer-title">Developer</h2><p>Connect your scripts to MyDrive with a personal API key.</p></div><button onClick={onClose}>Close</button></div>
    <p><a href="/docs/index">API documentation</a> · <a href="/docs/index.md">Markdown for AI</a></p>
    {error ? <p role="alert" className="notice notice-error">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <h3>Create API key</h3>
    <form onSubmit={e => { e.preventDefault(); void action(async () => { const result = await request<{ key: string }>('/api/developer/keys', { method: 'POST', csrf: true, json: { name, scopes: selected, expires_at: expiry ? new Date(expiry).toISOString() : null } }); setSecret(result.key); setName(''); }); }}>
      <div className="developer-controls"><label>Name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Lesson uploader" /></label><label>Expires at (optional)<input type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /></label></div>
      <fieldset><legend>Permissions</legend>{scopes.map(scope => <label key={scope} className="developer-scope"><input type="checkbox" checked={selected.includes(scope)} onChange={e => setSelected(v => e.target.checked ? [...v, scope] : v.filter(s => s !== scope))} />{scope}</label>)}</fieldset>
      <button disabled={busy || !selected.length || !!secret} type="submit">Create key</button>
    </form>
    {secret ? <div className="developer-secret"><strong>Copy this key now. It will only be shown once.</strong><pre>{secret}</pre><button onClick={() => { void navigator.clipboard.writeText(secret).then(() => setNotice('API key copied.')).catch(() => setError('Copy failed. Select and copy the key manually.')); }}>Copy key</button><button onClick={() => setSecret('')}>I saved the key</button></div> : null}
    <h3>API keys</h3><div className="developer-table-wrap"><table><thead><tr><th>Name / prefix</th><th>Permissions</th><th>Status / expiry</th><th>Last used</th><th>Actions</th></tr></thead><tbody>{keys.map(k => <tr key={k.id}><td>{k.name}<br /><code>{k.prefix}…</code></td><td>{k.scopes.join(', ')}</td><td>{k.revoked_at ? 'Revoked' : k.expires_at && new Date(k.expires_at) <= new Date() ? 'Expired' : 'Active'}<br />{k.expires_at ? new Date(k.expires_at).toLocaleString() : 'No expiry'}</td><td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td><td>{!k.revoked_at ? <button disabled={busy} onClick={() => { setRevoke(k); setSharesOnly(false); setRevokeShares(false); }}>Revoke key</button> : null}<button disabled={busy} onClick={() => { setRevoke(k); setSharesOnly(true); setRevokeShares(true); }}>Revoke its links</button></td></tr>)}</tbody></table></div>
    {nextKeyOffset !== null ? <button disabled={busy} onClick={() => { void action(async () => { const page = await request<{ keys: Key[]; next_offset: number | null }>('/api/developer/keys?offset=' + nextKeyOffset); setKeys(v => [...v, ...page.keys]); setNextKeyOffset(page.next_offset); }, false); }}>Load older keys</button> : null}
    {!keys.length ? <p>No API keys yet.</p> : null}
    {revoke ? <div className="developer-confirm" role="dialog" aria-modal="false" aria-labelledby="revoke-title"><h3 id="revoke-title">{sharesOnly ? 'Revoke links created by' : 'Revoke API key'} “{revoke.name}”?</h3><p>Existing share links keep working when a key is revoked unless you choose to revoke them too. You can revoke these links later, including after the key is revoked.</p>{!sharesOnly ? <label><input type="checkbox" checked={revokeShares} onChange={e => setRevokeShares(e.target.checked)} /> Also revoke all links created by this key</label> : <p>All links created by this key will stop working.</p>}<div><button disabled={busy} onClick={() => { void action(async () => { const result = await request<{ shares_revoked: number }>(`/api/developer/keys/${revoke.id}/${sharesOnly ? 'shares/revoke' : 'revoke'}`, { method: 'POST', csrf: true, ...(sharesOnly ? {} : { json: { revoke_shares: revokeShares } }) }); setNotice(`${sharesOnly ? 'Links revoked' : 'Key revoked'}. ${result.shares_revoked} links revoked.`); setRevoke(null); }); }}>Confirm revocation</button><button disabled={busy} onClick={() => setRevoke(null)}>Cancel</button></div></div> : null}
    <h3>Usage</h3><div className="developer-controls"><label>Period<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><label>API key<select value={filterKey} onChange={e => setFilterKey(e.target.value)}><option value="">All keys</option>{keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>{user.role === 'owner' || user.role === 'admin' ? <label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> All users</label> : null}<button onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    <p><strong>{total.toLocaleString()}</strong> requests · {usage.daily.reduce((s, d) => s + Number(d.errors), 0).toLocaleString()} errors · {(usage.daily.reduce((s, d) => s + Number(d.request_bytes), 0) / 1048576).toFixed(2)} MiB request traffic</p>
    <div className="developer-chart" role="img" aria-label={`API requests by UTC day: ${usage.daily.map(d => `${d.day}: ${d.requests}`).join('; ') || 'No requests'}`}>{usage.daily.map(d => <div key={d.day} title={`${d.day}: ${d.requests} requests, ${d.errors} errors`}><span style={{ height: `${Math.max(2, Number(d.requests) / peak * 140)}px` }} /><small>{d.day.slice(5)}</small></div>)}</div>
    <div className="developer-table-wrap"><table><thead><tr><th>User</th><th>Requests</th><th>Errors</th><th>Request bytes</th></tr></thead><tbody>{usage.users.map(u => <tr key={u.owner_id}><td>{u.email}</td><td>{u.requests}</td><td>{u.errors}</td><td>{u.request_bytes}</td></tr>)}</tbody></table></div>
    <h3>Request logs</h3><p>Logs are retained for 90 days. Request bodies, tokens and query strings are never recorded.</p><div className="developer-table-wrap"><table><thead><tr><th>Time</th><th>Key / user</th><th>Request</th><th>Status</th><th>Duration</th></tr></thead><tbody>{logs.map(l => <tr key={l.id}><td>{new Date(l.created_at).toLocaleString()}</td><td>{keys.find(k => k.id === l.api_key_id)?.name || l.api_key_id}<br /><small>{l.owner_id}</small></td><td><code>{l.method} {l.route}</code></td><td>{l.status}</td><td>{l.duration_ms} ms</td></tr>)}</tbody></table></div>
    {next ? <button disabled={busy} onClick={() => { void action(async () => { const page = await request<{ logs: Log[]; next_before_id: number | null }>('/api/developer/logs' + query + '&before_id=' + next); setLogs(v => [...v, ...page.logs]); setNext(page.next_before_id); }, false); }}>Load older logs</button> : null}
    <p>Manage individual share links in <a href="/shared">Shared links</a>.</p>
  </section>;
}
