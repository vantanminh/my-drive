# Usage, logs and administration

[Overview](/docs/index.md)

Open **Settings → Developer** for request charts, key filters, time range (7/30/90 days), request counts, errors, request traffic and request logs. Owners/admins can enable **All users** to view aggregate statistics and per-user totals; members can see only their own activity. API keys never grant administrator access.

Browser-session endpoints:

| Method | Path | Query / response |
|---|---|---|
| GET | /api/developer/usage | `days` (1–90, default 30), `key_id`, `all`, `owner_id`; `{daily,users,days}` |
| GET | /api/developer/logs | `key_id`, `all`, `owner_id`, `before_id`; `{logs,next_before_id}` |

`all=true` or another user's `owner_id` requires owner/admin role. Logs use keyset pagination, 100 records per page. Daily totals are grouped by UTC day; days without activity are omitted. The usage period is a rolling interval ending now. Request log pagination covers retained history independently of the usage chart period.

Each authenticated API request records caller and key IDs, method, route template, status, elapsed handler time and request payload bytes consumed by the handler. Logs never store raw API keys, share tokens, passwords, bodies or query strings. Invalid credentials cannot be attributed to an owner and are not included in per-user charts. Authenticated scope denials and rate-limit denials are recorded.

Traffic counts actual request payload bytes read by handlers, including streamed chunks without Content-Length. It excludes response/download bytes, headers and payloads rejected before being read; it is not total wire bandwidth. Duration measures authentication-completed handler time, not streaming transfer completion. Logs are pruned after 90 days by bounded batches in the existing maintenance worker. Historical key records remain available after revocation.
