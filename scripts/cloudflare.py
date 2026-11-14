"""Cloudflare Tunnel provisioning for vps.py (standard library only).

Needs an API token with: Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit
and Zone > Zone > Read for the zone that contains the chosen hostname. The API
token is used only during installation and is never written to disk; the
installation keeps only the tunnel's connector token.
"""
from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.cloudflare.com/client/v4'
TOKEN_RE = re.compile(r'[A-Za-z0-9_-]{20,200}')
CONNECTOR_IMAGE = 'cloudflare/cloudflared:2025.11.1'
MAX_REPLICAS = 8
TUNNEL_TARGET = '.cfargotunnel.com'


class CloudflareError(ValueError):
    pass


def valid_token(token):
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token.strip()):
        raise CloudflareError('Cloudflare API token looks invalid (copy the whole token, not the Global API Key)')
    return token.strip()


def api(token, method, path, body=None, query=None):
    url = API + path + (('?' + urllib.parse.urlencode(query)) if query else '')
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'my-drive-installer'})
    try:
        with urllib.request.urlopen(request, timeout=30, context=ssl.create_default_context()) as response:
            payload = json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b'{}')
        except ValueError:
            payload = {}
        messages = '; '.join(e.get('message', '') for e in payload.get('errors', []) if isinstance(e, dict))
        if error.code in (401, 403):
            raise CloudflareError(f'Cloudflare refused {method} {path.split("/")[1]}: token lacks permission '
                                  f'({messages or error.code}). Required: Account Cloudflare Tunnel Edit, '
                                  'Zone DNS Edit, Zone Read.') from None
        raise CloudflareError(f'Cloudflare API error {error.code}: {messages or error.reason}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise CloudflareError(f'cannot reach api.cloudflare.com: {getattr(error, "reason", error)}') from None
    if not payload.get('success', False):
        messages = '; '.join(e.get('message', '') for e in payload.get('errors', []) if isinstance(e, dict))
        raise CloudflareError(f'Cloudflare API error: {messages or "request failed"}')
    return payload.get('result')


def find_zone(token, host):
    labels = host.split('.')
    for start in range(len(labels) - 1):
        name = '.'.join(labels[start:])
        zones = api(token, 'GET', '/zones', query={'name': name})
        if zones:
            zone = zones[0]
            if zone.get('status') not in ('active', 'pending'):
                raise CloudflareError(f'zone {name} is {zone.get("status")}; finish adding it to Cloudflare first')
            return zone
    raise CloudflareError(f'no Cloudflare zone for {host} is visible to this token. Add the domain to '
                          'Cloudflare and grant the token access to that zone.')


def tunnel_name(host):
    return 'my-drive-' + host.replace('.', '-')[:50]


def inspect(token, host):
    """Read-only check: token, zone, account, permissions and DNS conflicts."""
    token = valid_token(token)
    zone = find_zone(token, host)
    account = zone.get('account') or {}
    if not account.get('id'):
        raise CloudflareError('zone has no account id; use a token scoped to the account that owns the zone')
    # Listing proves read access to both resources the installer must edit.
    tunnels = api(token, 'GET', f"/accounts/{account['id']}/cfd_tunnel",
                  query={'name': tunnel_name(host), 'is_deleted': 'false'})
    records = api(token, 'GET', f"/zones/{zone['id']}/dns_records", query={'name': host})
    conflicts = [f"{r['type']} {r['content']}" for r in records
                 if r['type'] in ('A', 'AAAA', 'CNAME') and not str(r['content']).endswith(TUNNEL_TARGET)]
    blocking = [f"{r['type']} {r['content']}" for r in records if r['type'] not in ('A', 'AAAA', 'CNAME')]
    if blocking:
        raise CloudflareError(f'{host} already has DNS records that cannot coexist with a tunnel CNAME: '
                              + ', '.join(blocking))
    return {'zone': zone['name'], 'zone_id': zone['id'], 'zone_status': zone.get('status'),
            'account': account.get('name', ''), 'account_id': account['id'],
            'existing_tunnel': bool(tunnels), 'replace_records': conflicts}


def provision(token, host):
    """Create (or reuse) the tunnel, route the hostname to the local proxy and the DNS CNAME."""
    info = inspect(token, host)
    account, zone = info['account_id'], info['zone_id']
    tunnels = api(token, 'GET', f'/accounts/{account}/cfd_tunnel',
                  query={'name': tunnel_name(host), 'is_deleted': 'false'})
    if tunnels:
        tunnel = tunnels[0]
    else:
        tunnel = api(token, 'POST', f'/accounts/{account}/cfd_tunnel',
                     {'name': tunnel_name(host), 'config_src': 'cloudflare'})
    tunnel_id = tunnel['id']
    connector = api(token, 'GET', f'/accounts/{account}/cfd_tunnel/{tunnel_id}/token')
    if not isinstance(connector, str) or not connector:
        raise CloudflareError('Cloudflare returned no tunnel connector token')
    # Remote-managed ingress: the hostname goes to the local Caddy proxy, everything else 404.
    api(token, 'PUT', f'/accounts/{account}/cfd_tunnel/{tunnel_id}/configurations', {'config': {'ingress': [
        {'hostname': host, 'service': 'http://proxy:80',
         'originRequest': {'httpHostHeader': host, 'connectTimeout': 30}},
        {'service': 'http_status:404'}]}})
    target = tunnel_id + TUNNEL_TARGET
    records = api(token, 'GET', f'/zones/{zone}/dns_records', query={'name': host})
    record = {'type': 'CNAME', 'name': host, 'content': target, 'proxied': True, 'ttl': 1,
              'comment': 'My Drive Cloudflare Tunnel'}
    cname = next((r for r in records if r['type'] == 'CNAME'), None)
    for stale in records:
        if stale['type'] in ('A', 'AAAA') or (stale['type'] == 'CNAME' and stale is not cname):
            api(token, 'DELETE', f"/zones/{zone}/dns_records/{stale['id']}")
    if cname:
        api(token, 'PUT', f"/zones/{zone}/dns_records/{cname['id']}", record)
    else:
        api(token, 'POST', f'/zones/{zone}/dns_records', record)
    return {'account_id': account, 'zone_id': zone, 'tunnel_id': tunnel_id,
            'tunnel_name': tunnel.get('name', tunnel_name(host)), 'connector_token': connector}


def wait_connected(token, account, tunnel_id, replicas, timeout=180):
    """Wait until every connector replica is registered with Cloudflare's edge."""
    deadline = time.monotonic() + timeout
    seen = 0
    while time.monotonic() < deadline:
        connections = api(token, 'GET', f'/accounts/{account}/cfd_tunnel/{tunnel_id}/connections') or []
        clients = [c for c in connections if c.get('conns')]
        seen = sum(len(c['conns']) for c in clients)
        if len(clients) >= replicas:
            return {'connectors': len(clients), 'connections': seen,
                    'colos': sorted({conn.get('colo_name', '') for c in clients for conn in c['conns']} - {''})}
        time.sleep(5)
    raise CloudflareError(f'only {seen} tunnel connection(s) came up within {timeout}s; '
                          'check outbound access to Cloudflare (TCP/UDP 7844) and run my-drive logs cloudflared')
