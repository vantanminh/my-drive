import * as SQLite from 'expo-sqlite';

import type { SyncLedgerRecord } from '../types/mydrive';
import type { SyncLedgerStats, SyncLedgerStore } from './syncLedger';

export { InMemorySyncLedgerStore, type SyncLedgerStats, type SyncLedgerStore } from './syncLedger';

interface SqliteRow {
  asset_id: string;
  server_url: string;
  filename: string;
  media_type: 'image' | 'video';
  size_bytes: number;
  sha256: string | null;
  remote_file_id: string | null;
  modification_time_ms: number;
  was_in_icloud: number;
  status: SyncLedgerRecord['status'];
  last_error: string | null;
  synced_at: string;
}

function fromRow(row: SqliteRow): SyncLedgerRecord {
  return {
    ...row,
    was_in_icloud: row.was_in_icloud === 1,
  };
}

export class SqliteSyncLedgerStore implements SyncLedgerStore {
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

  private async getDb(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const db = await SQLite.openDatabaseAsync('mydrive_sync.db');
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS sync_ledger (
            server_url TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            sha256 TEXT,
            remote_file_id TEXT,
            modification_time_ms INTEGER NOT NULL,
            was_in_icloud INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            last_error TEXT,
            synced_at TEXT NOT NULL,
            PRIMARY KEY (server_url, asset_id)
          );
          CREATE INDEX IF NOT EXISTS idx_sync_ledger_recent
            ON sync_ledger (server_url, synced_at DESC);
        `);
        return db;
      })();
    }
    return this.dbPromise;
  }

  async get(serverUrl: string, assetId: string): Promise<SyncLedgerRecord | null> {
    const db = await this.getDb();
    const row = await db.getFirstAsync<SqliteRow>(
      `SELECT asset_id, server_url, filename, media_type, size_bytes, sha256,
              remote_file_id, modification_time_ms, was_in_icloud, status, last_error, synced_at
         FROM sync_ledger
        WHERE server_url = ? AND asset_id = ?`,
      [serverUrl, assetId],
    );
    return row ? fromRow(row) : null;
  }

  async upsert(record: SyncLedgerRecord): Promise<void> {
    const db = await this.getDb();
    await db.runAsync(
      `INSERT INTO sync_ledger (
         server_url, asset_id, filename, media_type, size_bytes, sha256,
         remote_file_id, modification_time_ms, was_in_icloud, status, last_error, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_url, asset_id) DO UPDATE SET
         filename = excluded.filename,
         media_type = excluded.media_type,
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         remote_file_id = excluded.remote_file_id,
         modification_time_ms = excluded.modification_time_ms,
         was_in_icloud = excluded.was_in_icloud,
         status = excluded.status,
         last_error = excluded.last_error,
         synced_at = excluded.synced_at`,
      [
        record.server_url,
        record.asset_id,
        record.filename,
        record.media_type,
        record.size_bytes,
        record.sha256,
        record.remote_file_id,
        Math.round(record.modification_time_ms),
        record.was_in_icloud ? 1 : 0,
        record.status,
        record.last_error,
        record.synced_at,
      ],
    );
  }

  async listRecent(serverUrl: string, limit = 80): Promise<SyncLedgerRecord[]> {
    const db = await this.getDb();
    const rows = await db.getAllAsync<SqliteRow>(
      `SELECT asset_id, server_url, filename, media_type, size_bytes, sha256,
              remote_file_id, modification_time_ms, was_in_icloud, status, last_error, synced_at
         FROM sync_ledger
        WHERE server_url = ?
        ORDER BY synced_at DESC
        LIMIT ?`,
      [serverUrl, limit],
    );
    return rows.map(fromRow);
  }

  async getStats(serverUrl: string): Promise<SyncLedgerStats> {
    const db = await this.getDb();
    const row = await db.getFirstAsync<{
      synced_count: number;
      deduped_count: number;
      waiting_wifi_count: number;
      error_count: number;
      icloud_count: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'synced' THEN 1 ELSE 0 END), 0) AS synced_count,
         COALESCE(SUM(CASE WHEN status = 'deduplicated' THEN 1 ELSE 0 END), 0) AS deduped_count,
         COALESCE(SUM(CASE WHEN status = 'icloud_waiting_wifi' THEN 1 ELSE 0 END), 0) AS waiting_wifi_count,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_count,
         COALESCE(SUM(CASE WHEN was_in_icloud = 1 AND status IN ('synced', 'deduplicated') THEN 1 ELSE 0 END), 0) AS icloud_count
       FROM sync_ledger
      WHERE server_url = ?`,
      [serverUrl],
    );
    return {
      syncedCount: row?.synced_count ?? 0,
      dedupedCount: row?.deduped_count ?? 0,
      waitingWifiCount: row?.waiting_wifi_count ?? 0,
      errorCount: row?.error_count ?? 0,
      icloudOriginalsCount: row?.icloud_count ?? 0,
    };
  }

  async clearServer(serverUrl: string): Promise<void> {
    const db = await this.getDb();
    await db.runAsync('DELETE FROM sync_ledger WHERE server_url = ?', [serverUrl]);
  }
}
