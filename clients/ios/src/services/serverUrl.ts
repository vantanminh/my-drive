import type { ServerCapabilities, ServerProbeResult } from '../types/mydrive';

export interface NormalizedServerUrl {
  url: string;
  hostname: string;
  port: string | null;
  isInsecureHttp: boolean;
  isLocalNetworkHost: boolean;
  wasAdjusted: boolean;
}

export class ServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

const APP_ROUTE_PREFIXES = [
  '/login',
  '/drive',
  '/photos',
  '/shared',
  '/trash',
  '/storage',
  '/accounts',
  '/faces',
  '/indexing',
  '/settings',
  '/security',
  '/updates',
  '/device',
  '/google-drive',
  '/api',
];

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true;
  }
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal')) {
    return true;
  }
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4Match) return false;
  const octets = ipv4Match.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / CGNAT
  return false;
}

function defaultSchemeForInput(rawHostPart: string): 'http' | 'https' {
  const withoutPath = rawHostPart.split('/')[0] ?? '';
  let hostname = withoutPath;
  if (withoutPath.startsWith('[')) {
    const endBracket = withoutPath.indexOf(']');
    hostname = endBracket > 0 ? withoutPath.slice(0, endBracket + 1) : withoutPath;
  } else {
    hostname = withoutPath.split(':')[0] ?? '';
  }
  return isPrivateOrLocalHostname(hostname) ? 'http' : 'https';
}

/**
 * Normalizes and validates a user-entered NAS / MyDrive URL.
 * Supports HTTPS domains, custom ports, Tailscale/WireGuard IPs, `.local` mDNS names, and LAN HTTP IPs.
 */
export function normalizeServerUrl(rawInput: string): NormalizedServerUrl {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new ServerUrlError('Please enter your NAS or MyDrive server URL.');
  }
  if (/[\s\u0000-\u001f]/.test(trimmed)) {
    throw new ServerUrlError('Server URL cannot contain spaces or control characters.');
  }

  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  if (!hasExplicitScheme && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // Handles values like `javascript:alert(1)` or `ftp://...` without `://`
    if (!/^[a-zA-Z0-9.-]+:\d{1,5}(\/|$)/.test(trimmed)) {
      throw new ServerUrlError('Unsupported URL scheme. Use https:// or http://.');
    }
  }

  const candidate = hasExplicitScheme
    ? trimmed
    : `${defaultSchemeForInput(trimmed)}://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ServerUrlError('Invalid server URL. Example: https://nas.example.com or http://192.168.1.50:8080');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ServerUrlError('Only https:// and http:// server addresses are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new ServerUrlError('Do not embed a username or password inside the NAS URL.');
  }
  if (!parsed.hostname) {
    throw new ServerUrlError('Server URL must include a valid hostname or IP address.');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const strippedKnownRoute = APP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  // MyDrive serves `/health/live`, `/.well-known/cloud-client`, and `/api/*` at the server origin.
  const basePath = strippedKnownRoute ? '' : pathname;
  const normalizedUrl = `${parsed.protocol}//${parsed.host}${basePath}`;
  const isInsecureHttp = parsed.protocol === 'http:';
  const isLocalNetworkHost = isPrivateOrLocalHostname(parsed.hostname);

  const rawNormalizedInput = trimmed.replace(/\/+$/, '');
  const wasAdjusted =
    !hasExplicitScheme ||
    strippedKnownRoute ||
    Boolean(parsed.search) ||
    Boolean(parsed.hash) ||
    normalizedUrl !== rawNormalizedInput;

  return {
    url: normalizedUrl,
    hostname: parsed.hostname,
    port: parsed.port || null,
    isInsecureHttp,
    isLocalNetworkHost,
    wasAdjusted,
  };
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Probes a MyDrive NAS server URL using `/health/live` and `/.well-known/cloud-client`.
 */
export async function probeServer(
  rawOrNormalizedUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 7000,
): Promise<ServerProbeResult> {
  const normalized = normalizeServerUrl(rawOrNormalizedUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const liveResponse = await fetchImpl(`${normalized.url}/health/live`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!liveResponse.ok) {
      throw new ServerUrlError(
        `Server responded with HTTP ${liveResponse.status} on /health/live.`,
      );
    }

    let capabilities: ServerCapabilities | null = null;
    try {
      const capResponse = await fetchImpl(
        `${normalized.url}/.well-known/cloud-client`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (capResponse.ok) {
        const data = (await capResponse.json()) as Partial<ServerCapabilities>;
        if (data.product && data.product !== 'my-drive') {
          throw new ServerUrlError(
            `Unexpected server product "${data.product}". Expected a MyDrive server.`,
          );
        }
        if (data.product === 'my-drive' && data.features) {
          capabilities = data as ServerCapabilities;
        }
      }
    } catch (err) {
      if (err instanceof ServerUrlError) throw err;
    }

    return {
      normalizedUrl: normalized.url,
      isInsecureHttp: normalized.isInsecureHttp,
      liveOk: true,
      capabilities,
    };
  } catch (error) {
    if (error instanceof ServerUrlError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServerUrlError(
        `Connection to ${normalized.url} timed out. Check your NAS URL, Wi-Fi/Tailscale, or firewall.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ServerUrlError(`Could not reach ${normalized.url}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
