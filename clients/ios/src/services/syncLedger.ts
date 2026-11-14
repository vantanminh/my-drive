import type { SyncLedgerRecord } from '../types/mydrive';

export interface SyncLedgerStats {
  syncedCount: number;
  dedupedCount: number;
  waitingWifiCount: number;
  errorCount: number;
  icloudOriginalsCount: number;
}

export interface SyncLedgerStore {
  get(serverUrl: string, assetId: string): Promise<SyncLedgerRecord | null>;
  upsert(record: SyncLedgerRecord): Promise<void>;
  listRecent(serverUrl: string, limit?: number): Promise<SyncLedgerRecord[]>;
  getStats(serverUrl: string): Promise<SyncLedgerStats>;
  clearServer(serverUrl: string): Promise<void>;
}

export class InMemorySyncLedgerStore implements SyncLedgerStore {
  private readonly records = new Map<string, SyncLedgerRecord>();

  private key(serverUrl: string, assetId: string): string {
    return `${serverUrl}::${assetId}`;
  }

  async get(serverUrl: string, assetId: string): Promise<SyncLedgerRecord | null> {
    return this.records.get(this.key(serverUrl, assetId)) ?? null;
  }

  async upsert(record: SyncLedgerRecord): Promise<void> {
    this.records.set(this.key(record.server_url, record.asset_id), { ...record });
  }

  async listRecent(serverUrl: string, limit = 80): Promise<SyncLedgerRecord[]> {
    return Array.from(this.records.values())
      .filter((r) => r.server_url === serverUrl)
      .sort((a, b) => b.synced_at.localeCompare(a.synced_at))
      .slice(0, limit);
  }

  async getStats(serverUrl: string): Promise<SyncLedgerStats> {
    let syncedCount = 0;
    let dedupedCount = 0;
    let waitingWifiCount = 0;
    let errorCount = 0;
    let icloudOriginalsCount = 0;

    for (const item of this.records.values()) {
      if (item.server_url !== serverUrl) continue;
      if (item.status === 'synced') syncedCount += 1;
      if (item.status === 'deduplicated') dedupedCount += 1;
      if (item.status === 'icloud_waiting_wifi') waitingWifiCount += 1;
      if (item.status === 'error') errorCount += 1;
      if (item.was_in_icloud && (item.status === 'synced' || item.status === 'deduplicated')) {
        icloudOriginalsCount += 1;
      }
    }
    return { syncedCount, dedupedCount, waitingWifiCount, errorCount, icloudOriginalsCount };
  }

  async clearServer(serverUrl: string): Promise<void> {
    for (const [k, v] of this.records.entries()) {
      if (v.server_url === serverUrl) this.records.delete(k);
    }
  }
}
