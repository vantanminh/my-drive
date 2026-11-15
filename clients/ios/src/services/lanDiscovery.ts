import type {
  NativeDiscoveredLanServer,
  WifiSubnetInfo,
} from '../../modules/mydrive-media-sync/src';
import type {
  DiscoveredLanServer,
  LanConnectionMode,
  ServerCapabilities,
} from '../types/mydrive';

interface NativeLanBridge {
  discoverLanServersNative(ports?: number[]): Promise<NativeDiscoveredLanServer[]>;
  getWifiSubnetInfo(): Promise<WifiSubnetInfo | null>;
  isNativeMediaSyncAvailable(): boolean;
}

function getNativeLanBridge(): NativeLanBridge | null {
  // Skip React Native native module load when running pure domain tests under Node/tsx.
  if (typeof process !== 'undefined' && Boolean(process.versions?.node)) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../modules/mydrive-media-sync/src') as NativeLanBridge;
  } catch {
    return null;
  }
}

const LAN_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.localdomain'];
const DEFAULT_LAN_PORTS = [3000, 80, 8080, 443, 8443];

export interface LanProbeMatch {
  url: string;
  capabilities: ServerCapabilities;
  latencyMs: number;
  matchedServerId: boolean;
}

export interface EndpointSelectionResult {
  activeUrl: string;
  mode: LanConnectionMode;
  latencyMs: number | null;
  lanReachable: boolean;
  serverId: string | null;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function isTailscaleCgnatIp(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n, idx) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== parts[idx])) {
    return false;
  }
  const [a, b] = nums;
  return a === 100 && b >= 64 && b <= 127;
}

export function isRfc1918Ipv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n, idx) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== parts[idx])) {
    return false;
  }
  const [a, b] = nums;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Returns true for physical local network addresses (RFC1918 IPv4 or `.local`/`.lan`/etc.),
 * excluding overlay VPNs like Tailscale (`100.64.0.0/10`) and loopback.
 */
export function isLanHostname(rawHostname: string): boolean {
  const host = stripIpv6Brackets(rawHostname.trim().toLowerCase());
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    return false;
  }
  if (isTailscaleCgnatIp(host)) {
    return false;
  }
  if (isRfc1918Ipv4(host)) {
    return true;
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  return LAN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function extractHostname(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

export function isLanUrl(rawUrl: string | null | undefined): boolean {
  const host = extractHostname(rawUrl);
  return host ? isLanHostname(host) : false;
}

export function normalizeEndpointUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

export async function probeLanEndpoint(
  baseUrl: string,
  options?: {
    expectedServerId?: string | null;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<LanProbeMatch | null> {
  const normalized = normalizeEndpointUrl(baseUrl);
  const timeoutMs = options?.timeoutMs ?? 1500;
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchFn(`${normalized}/.well-known/cloud-client`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<ServerCapabilities> | null;
    if (!payload || payload.product !== 'my-drive') {
      return null;
    }

    const expectedId = options?.expectedServerId?.trim().toLowerCase() ?? null;
    const foundId =
      typeof payload.serverId === 'string' && payload.serverId.trim()
        ? payload.serverId.trim().toLowerCase()
        : null;

    // When both primary server and candidate advertise serverId, reject any mismatched NAS.
    if (expectedId && foundId && expectedId !== foundId) {
      return null;
    }

    const latencyMs = Math.max(1, Date.now() - startedAt);
    return {
      url: normalized,
      capabilities: payload as ServerCapabilities,
      latencyMs,
      matchedServerId: Boolean(expectedId && foundId && expectedId === foundId),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildQuickLanCandidates(params: {
  knownLanUrl?: string | null;
  primaryServerUrl?: string | null;
  ports?: number[];
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    if (!url) return;
    const trimmed = normalizeEndpointUrl(url);
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  if (params.knownLanUrl) {
    push(params.knownLanUrl);
  }
  if (params.primaryServerUrl && isLanUrl(params.primaryServerUrl)) {
    push(params.primaryServerUrl);
  }

  // Common NAS hostnames / ports on local mDNS.
  for (const host of ['mydrive.local', 'nas.local']) {
    push(`http://${host}:3000`);
    push(`http://${host}`);
  }

  // Preserve custom primary port when primary server uses a non-default port.
  if (params.primaryServerUrl) {
    try {
      const parsed = new URL(params.primaryServerUrl);
      const customPort = parsed.port ? Number.parseInt(parsed.port, 10) : null;
      if (customPort && !DEFAULT_LAN_PORTS.includes(customPort)) {
        push(`http://mydrive.local:${customPort}`);
      }
    } catch {
      // Ignore unparseable primary URL.
    }
  }

  return candidates;
}

export async function discoverLanNasServers(options?: {
  expectedServerId?: string | null;
  knownLanUrl?: string | null;
  primaryServerUrl?: string | null;
  ports?: number[];
  fetchImpl?: typeof fetch;
}): Promise<DiscoveredLanServer[]> {
  const ports = options?.ports?.length ? options.ports : DEFAULT_LAN_PORTS;
  const expectedId = options?.expectedServerId?.trim().toLowerCase() ?? null;
  const foundMap = new Map<string, DiscoveredLanServer>();

  const recordMatch = (entry: DiscoveredLanServer) => {
    const key = normalizeEndpointUrl(entry.url);
    const existing = foundMap.get(key);
    if (!existing || entry.latencyMs < existing.latencyMs) {
      foundMap.set(key, { ...entry, url: key });
    }
  };

  const quickUrls = buildQuickLanCandidates({
    knownLanUrl: options?.knownLanUrl,
    primaryServerUrl: options?.primaryServerUrl,
    ports,
  });

  const quickPromise = Promise.all(
    quickUrls.map(async (url) => {
      const match = await probeLanEndpoint(url, {
        expectedServerId: expectedId,
        timeoutMs: 1400,
        fetchImpl: options?.fetchImpl,
      });
      if (!match) return;
      const parsed = new URL(match.url);
      recordMatch({
        url: match.url,
        host: parsed.hostname,
        port: parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80,
        scheme: parsed.protocol === 'https:' ? 'https' : 'http',
        serverId: match.capabilities.serverId ?? null,
        serverVersion: match.capabilities.serverVersion ?? null,
        latencyMs: match.latencyMs,
        matchedServerId: match.matchedServerId,
        source: 'probe',
      });
    }),
  );

  const nativeBridge = getNativeLanBridge();
  const nativePromise =
    nativeBridge && nativeBridge.isNativeMediaSyncAvailable()
      ? nativeBridge.discoverLanServersNative(ports).catch(() => [])
      : Promise.resolve([]);

  const [, nativeHits] = await Promise.all([quickPromise, nativePromise]);

  for (const hit of nativeHits) {
    const hitId = hit.serverId?.trim().toLowerCase() ?? null;
    if (expectedId && hitId && expectedId !== hitId) {
      continue;
    }
    recordMatch({
      url: hit.url,
      host: hit.ip,
      port: hit.port,
      scheme: hit.scheme,
      serverId: hit.serverId ?? null,
      serverVersion: hit.serverVersion ?? null,
      latencyMs: hit.latencyMs,
      matchedServerId: Boolean(expectedId && hitId && expectedId === hitId),
      source: 'subnet',
    });
  }

  return Array.from(foundMap.values()).sort((a, b) => {
    if (a.matchedServerId !== b.matchedServerId) {
      return a.matchedServerId ? -1 : 1;
    }
    return a.latencyMs - b.latencyMs;
  });
}

export async function getLocalWifiSummary(): Promise<{
  localIp: string;
  subnetPrefix: string;
  interfaceName: string;
} | null> {
  const nativeBridge = getNativeLanBridge();
  if (!nativeBridge || !nativeBridge.isNativeMediaSyncAvailable()) return null;
  try {
    const info = await nativeBridge.getWifiSubnetInfo();
    if (!info) return null;
    return {
      localIp: info.localIp,
      subnetPrefix: info.subnetPrefix,
      interfaceName: info.interfaceName,
    };
  } catch {
    return null;
  }
}

export async function selectActiveEndpoint(options: {
  primaryUrl: string;
  pairedLanUrl: string | null;
  autoSwitchLan: boolean;
  expectedServerId?: string | null;
  isConnected?: boolean;
  isWifiOrEthernet?: boolean;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
}): Promise<EndpointSelectionResult> {
  const primary = normalizeEndpointUrl(options.primaryUrl);
  const timeoutMs = options.probeTimeoutMs ?? 1200;

  if (options.isConnected === false) {
    return {
      activeUrl: primary,
      mode: 'offline',
      latencyMs: null,
      lanReachable: false,
      serverId: options.expectedServerId ?? null,
    };
  }

  if (isLanUrl(primary)) {
    const probe = await probeLanEndpoint(primary, {
      expectedServerId: options.expectedServerId,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    return {
      activeUrl: primary,
      mode: probe ? 'lan' : 'remote',
      latencyMs: probe?.latencyMs ?? null,
      lanReachable: Boolean(probe),
      serverId: probe?.capabilities.serverId ?? options.expectedServerId ?? null,
    };
  }

  if (!options.autoSwitchLan || options.isWifiOrEthernet === false) {
    return {
      activeUrl: primary,
      mode: 'remote',
      latencyMs: null,
      lanReachable: false,
      serverId: options.expectedServerId ?? null,
    };
  }

  if (options.pairedLanUrl) {
    const lanCandidate = normalizeEndpointUrl(options.pairedLanUrl);
    const probe = await probeLanEndpoint(lanCandidate, {
      expectedServerId: options.expectedServerId,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (probe) {
      return {
        activeUrl: probe.url,
        mode: 'lan',
        latencyMs: probe.latencyMs,
        lanReachable: true,
        serverId: probe.capabilities.serverId ?? options.expectedServerId ?? null,
      };
    }
  }

  return {
    activeUrl: primary,
    mode: 'remote',
    latencyMs: null,
    lanReachable: false,
    serverId: options.expectedServerId ?? null,
  };
}
