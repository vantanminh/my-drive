using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace MyDrive.Backup;

public sealed class LocalDatabase : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly object _gate = new();

    public LocalDatabase(string databasePath)
    {
        var directory = Path.GetDirectoryName(databasePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connection = new SqliteConnection($"Data Source={databasePath};Mode=ReadWriteCreate;Cache=Shared");
        _connection.Open();
        Initialize();
    }

    public void Dispose() => _connection.Dispose();

    public ServerProfile? GetServer() => GetJson<ServerProfile>("server");

    public void SaveServer(ServerProfile profile)
    {
        profile.UpdatedAt = DateTimeOffset.UtcNow;
        PutJson("server", profile);
    }

    public ClientSettings GetSettings() => GetJson<ClientSettings>("settings") ?? new ClientSettings();

    public void SaveSettings(ClientSettings settings) => PutJson("settings", settings);

    public bool GetFlag(string key)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key";
            command.Parameters.AddWithValue("$key", "flag:" + key);
            return command.ExecuteScalar() as string == "1";
        }
    }

    public string? GetMeta(string key)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        }
    }

    public void SetMeta(string key, string value)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO meta(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", value);
            command.ExecuteNonQuery();
        }
    }

    public void SetFlag(string key, bool value)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO meta(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
            command.Parameters.AddWithValue("$key", "flag:" + key);
            command.Parameters.AddWithValue("$value", value ? "1" : "0");
            command.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<BackupJob> ListJobs()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT document FROM jobs ORDER BY rowid";
            using var reader = command.ExecuteReader();
            var jobs = new List<BackupJob>();
            while (reader.Read())
            {
                var job = JsonSerializer.Deserialize<BackupJob>(reader.GetString(0), JsonOpts.Store);
                if (job != null)
                {
                    jobs.Add(job);
                }
            }

            return jobs;
        }
    }

    public BackupJob? GetJob(string id)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT document FROM jobs WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            var json = command.ExecuteScalar() as string;
            return json == null ? null : JsonSerializer.Deserialize<BackupJob>(json, JsonOpts.Store);
        }
    }

    public void SaveJob(BackupJob job)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO jobs(id, document, bound_server, paused, scan_generation, last_scan_at, status)
                VALUES($id, $document, $server, $paused, $generation, $scan, $status)
                ON CONFLICT(id) DO UPDATE SET
                  document = excluded.document,
                  bound_server = excluded.bound_server,
                  paused = excluded.paused,
                  scan_generation = excluded.scan_generation,
                  last_scan_at = excluded.last_scan_at,
                  status = excluded.status
                """;
            BindJob(command, job);
            command.ExecuteNonQuery();
        }
    }

    public void DeleteJob(string id)
    {
        lock (_gate)
        {
            using var transaction = _connection.BeginTransaction();
            Execute("DELETE FROM upload_queue WHERE job_id = $id", ("$id", id));
            Execute("DELETE FROM file_index WHERE job_id = $id", ("$id", id));
            Execute("DELETE FROM jobs WHERE id = $id", ("$id", id));
            transaction.Commit();
        }
    }

    public long NextScanGeneration(string jobId)
    {
        lock (_gate)
        {
            var job = GetJobUnlocked(jobId) ?? throw new InvalidOperationException("Backup job was not found.");
            job.ScanGeneration++;
            SaveJobUnlocked(job);
            return job.ScanGeneration;
        }
    }

    public FileIndexRow? FindIndex(string jobId, string relativePath)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT * FROM file_index WHERE job_id = $job AND relative_path = $path";
            command.Parameters.AddWithValue("$job", jobId);
            command.Parameters.AddWithValue("$path", relativePath);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadIndex(reader) : null;
        }
    }

    public void UpsertIndex(FileIndexRow row)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO file_index(
                  job_id, relative_path, file_size, modified_unix_ms, content_hash, remote_file_id,
                  remote_version_id, remote_checksum, last_backup_at, status, seen_generation, delete_after)
                VALUES($job, $path, $size, $mtime, $hash, $file, $version, $checksum, $backup, $status, $seen, $delete)
                ON CONFLICT(job_id, relative_path) DO UPDATE SET
                  file_size = excluded.file_size,
                  modified_unix_ms = excluded.modified_unix_ms,
                  content_hash = excluded.content_hash,
                  remote_file_id = excluded.remote_file_id,
                  remote_version_id = excluded.remote_version_id,
                  remote_checksum = excluded.remote_checksum,
                  last_backup_at = excluded.last_backup_at,
                  status = excluded.status,
                  seen_generation = excluded.seen_generation,
                  delete_after = excluded.delete_after
                """;
            BindIndex(command, row);
            command.ExecuteNonQuery();
        }
    }

    public void DeleteIndex(string jobId, string relativePath)
    {
        lock (_gate)
        {
            Execute("DELETE FROM file_index WHERE job_id = $job AND relative_path = $path", ("$job", jobId), ("$path", relativePath));
        }
    }

    public IReadOnlyList<FileIndexRow> ListUnseen(string jobId, long generation)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT * FROM file_index
                WHERE job_id = $job AND seen_generation < $generation AND status = 'backed_up'
                """;
            command.Parameters.AddWithValue("$job", jobId);
            command.Parameters.AddWithValue("$generation", generation);
            return ReadIndexList(command);
        }
    }

    public IReadOnlyList<FileIndexRow> ListByHash(string jobId, string hash, long size, long generation)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT * FROM file_index
                WHERE job_id = $job AND content_hash = $hash AND file_size = $size
                  AND seen_generation = $generation AND status = 'pending'
                """;
            command.Parameters.AddWithValue("$job", jobId);
            command.Parameters.AddWithValue("$hash", hash);
            command.Parameters.AddWithValue("$size", size);
            command.Parameters.AddWithValue("$generation", generation);
            return ReadIndexList(command);
        }
    }

    public IReadOnlyList<FileIndexRow> ListDueDeletions(DateTimeOffset now)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT * FROM file_index
                WHERE delete_after IS NOT NULL AND delete_after <= $now AND status != 'deleted'
                """;
            command.Parameters.AddWithValue("$now", now.ToString("O"));
            return ReadIndexList(command);
        }
    }

    public void ClearJobIndex(string jobId)
    {
        lock (_gate)
        {
            Execute("DELETE FROM file_index WHERE job_id = $job", ("$job", jobId));
            Execute("DELETE FROM upload_queue WHERE job_id = $job AND state NOT IN ('Completed')", ("$job", jobId));
        }
    }

    public void Enqueue(UploadItem item)
    {
        lock (_gate)
        {
            using var existing = _connection.CreateCommand();
            existing.CommandText =
                """
                SELECT id FROM upload_queue
                WHERE job_id = $job AND relative_path = $path AND state NOT IN ('Completed', 'Skipped', 'Failed')
                """;
            existing.Parameters.AddWithValue("$job", item.JobId);
            existing.Parameters.AddWithValue("$path", item.RelativePath);
            if (existing.ExecuteScalar() is string id)
            {
                using var current = _connection.CreateCommand();
                current.CommandText = "SELECT content_hash, remote_upload_id, bytes_sent, retry_count, state FROM upload_queue WHERE id = $id";
                current.Parameters.AddWithValue("$id", id);
                using var reader = current.ExecuteReader();
                if (!reader.Read())
                {
                    return;
                }

                var sameContent = string.Equals(Optional(reader, "content_hash"), item.ContentHash, StringComparison.OrdinalIgnoreCase);
                item.Id = id;
                if (sameContent)
                {
                    item.RemoteUploadId = Optional(reader, "remote_upload_id");
                    item.BytesSent = reader.IsDBNull(reader.GetOrdinal("bytes_sent")) ? 0 : reader.GetInt64(reader.GetOrdinal("bytes_sent"));
                    item.RetryCount = reader.GetInt32(reader.GetOrdinal("retry_count"));
                    var state = reader.GetString(reader.GetOrdinal("state"));
                    if (state is QueueState.Retrying or QueueState.Paused or QueueState.Uploading or QueueState.Hashing or QueueState.CheckingServer)
                    {
                        item.State = state == QueueState.Uploading ? QueueState.Waiting : state;
                    }
                }

                reader.Close();
                SaveQueueUnlocked(item);
                return;
            }

            SaveQueueUnlocked(item);
        }
    }

    public void SaveQueue(UploadItem item)
    {
        lock (_gate)
        {
            SaveQueueUnlocked(item);
        }
    }

    public UploadItem? ClaimNext(DateTimeOffset now)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                UPDATE upload_queue
                SET state = 'Uploading', updated_at = $now
                WHERE id = (
                  SELECT queue.id FROM upload_queue AS queue
                  JOIN jobs ON jobs.id = queue.job_id
                  WHERE queue.state IN ('Waiting', 'Retrying')
                    AND jobs.paused = 0
                    AND (queue.next_retry_at IS NULL OR queue.next_retry_at <= $now)
                  ORDER BY queue.created_at
                  LIMIT 1
                )
                RETURNING *
                """;
            command.Parameters.AddWithValue("$now", now.ToString("O"));
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadQueue(reader) : null;
        }
    }

    public void ResetInterrupted()
    {
        lock (_gate)
        {
            Execute(
                """
                UPDATE upload_queue
                SET state = 'Waiting', error = NULL
                WHERE state IN ('Hashing', 'CheckingServer', 'Uploading')
                """);
        }
    }

    public void FinishQueued(string jobId, string relativePath, string state, string? error)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                UPDATE upload_queue
                SET state = $state, error = $error, updated_at = $now
                WHERE job_id = $job AND relative_path = $path AND state NOT IN ('Completed', 'Skipped', 'Failed')
                """;
            command.Parameters.AddWithValue("$state", state);
            command.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
            command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
            command.Parameters.AddWithValue("$job", jobId);
            command.Parameters.AddWithValue("$path", relativePath);
            command.ExecuteNonQuery();
        }
    }

    public void DeleteSettling(string jobId, long generation)
    {
        lock (_gate)
        {
            Execute(
                "DELETE FROM file_index WHERE job_id = $job AND seen_generation < $generation AND status = 'settling'",
                ("$job", jobId),
                ("$generation", generation));
        }
    }

    public void ResumePausedQueue()
    {
        lock (_gate)
        {
            Execute("UPDATE upload_queue SET state = 'Waiting', next_retry_at = NULL WHERE state = 'Paused'");
        }
    }

    public IReadOnlyList<UploadItem> ListQueue(int limit = 200)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT * FROM upload_queue
                WHERE state NOT IN ('Completed', 'Skipped')
                ORDER BY updated_at DESC
                LIMIT $limit
                """;
            command.Parameters.AddWithValue("$limit", limit);
            var items = ReadQueueList(command);
            using var recent = _connection.CreateCommand();
            recent.CommandText =
                """
                SELECT * FROM upload_queue
                WHERE state IN ('Completed', 'Skipped')
                ORDER BY updated_at DESC
                LIMIT 40
                """;
            items.AddRange(ReadQueueList(recent));
            return items;
        }
    }

    public (int Queue, int Failed, int Retrying, long Remaining) QueueStats()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                SELECT
                  SUM(CASE WHEN state IN ('Waiting', 'Hashing', 'CheckingServer', 'Uploading', 'Retrying', 'Paused') THEN 1 ELSE 0 END),
                  SUM(CASE WHEN state = 'Failed' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN state = 'Retrying' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN state IN ('Waiting', 'Hashing', 'CheckingServer', 'Uploading', 'Retrying', 'Paused')
                           THEN MAX(file_size - bytes_sent, 0) ELSE 0 END)
                FROM upload_queue
                """;
            using var reader = command.ExecuteReader();
            if (!reader.Read())
            {
                return (0, 0, 0, 0);
            }

            return (ReadInt(reader, 0), ReadInt(reader, 1), ReadInt(reader, 2), ReadLong(reader, 3));
        }
    }

    public void AddActivity(string kind, string path, string? reason, string? jobId)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO activity(at, kind, path, reason, job_id) VALUES($at, $kind, $path, $reason, $job)";
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
            command.Parameters.AddWithValue("$kind", kind);
            command.Parameters.AddWithValue("$path", path);
            command.Parameters.AddWithValue("$reason", (object?)reason ?? DBNull.Value);
            command.Parameters.AddWithValue("$job", (object?)jobId ?? DBNull.Value);
            command.ExecuteNonQuery();
            Execute("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 5000)");
        }
    }

    public IReadOnlyList<ActivityEntry> ListActivity(string? kind, int limit = 300)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = kind is null or "" or "All"
                ? "SELECT id, at, kind, path, reason, job_id FROM activity ORDER BY id DESC LIMIT $limit"
                : "SELECT id, at, kind, path, reason, job_id FROM activity WHERE kind = $kind ORDER BY id DESC LIMIT $limit";
            command.Parameters.AddWithValue("$limit", limit);
            if (kind is not (null or "" or "All"))
            {
                command.Parameters.AddWithValue("$kind", kind);
            }

            using var reader = command.ExecuteReader();
            var entries = new List<ActivityEntry>();
            while (reader.Read())
            {
                entries.Add(new ActivityEntry
                {
                    Id = reader.GetInt64(0),
                    At = DateTimeOffset.Parse(reader.GetString(1)),
                    Kind = reader.GetString(2),
                    Path = reader.GetString(3),
                    Reason = reader.IsDBNull(4) ? null : reader.GetString(4),
                    JobId = reader.IsDBNull(5) ? null : reader.GetString(5),
                });
            }

            return entries;
        }
    }

    public void AddLog(string level, string message)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO logs(at, level, message) VALUES($at, $level, $message)";
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
            command.Parameters.AddWithValue("$level", level);
            command.Parameters.AddWithValue("$message", SecretRedactor.Redact(message));
            command.ExecuteNonQuery();
            Execute("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 5000)");
        }
    }

    public IReadOnlyList<LogEntry> ListLogs(int limit = 500)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT id, at, level, message FROM logs ORDER BY id DESC LIMIT $limit";
            command.Parameters.AddWithValue("$limit", limit);
            using var reader = command.ExecuteReader();
            var entries = new List<LogEntry>();
            while (reader.Read())
            {
                entries.Add(new LogEntry
                {
                    Id = reader.GetInt64(0),
                    At = DateTimeOffset.Parse(reader.GetString(1)),
                    Level = reader.GetString(2),
                    Message = reader.GetString(3),
                });
            }

            return entries;
        }
    }

    public string ExportLogs()
    {
        var lines = ListLogs(5000).Select(entry => $"{entry.At:O}\t{entry.Level}\t{entry.Message}");
        return string.Join('\n', lines);
    }

    public void ClearLogs()
    {
        lock (_gate)
        {
            Execute("DELETE FROM logs");
        }
    }

    public void EnqueueNotification(string title, string body)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO notifications(title, body, created_at) VALUES($title, $body, $at)";
            command.Parameters.AddWithValue("$title", title);
            command.Parameters.AddWithValue("$body", body);
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
            command.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<(string Title, string Body)> DrainNotifications()
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT id, title, body FROM notifications ORDER BY id LIMIT 20";
            using var reader = command.ExecuteReader();
            var items = new List<(long Id, string Title, string Body)>();
            while (reader.Read())
            {
                items.Add((reader.GetInt64(0), reader.GetString(1), reader.GetString(2)));
            }

            reader.Close();
            foreach (var item in items)
            {
                Execute("DELETE FROM notifications WHERE id = $id", ("$id", item.Id));
            }

            return items.Select(item => (item.Title, item.Body)).ToArray();
        }
    }

    public BackupOverview Overview()
    {
        lock (_gate)
        {
            using var jobs = _connection.CreateCommand();
            jobs.CommandText = "SELECT COUNT(*) FROM jobs";
            var folders = Convert.ToInt32(jobs.ExecuteScalar());
            using var files = _connection.CreateCommand();
            files.CommandText =
                """
                SELECT COUNT(*), COALESCE(SUM(file_size), 0), MAX(last_backup_at)
                FROM file_index WHERE status = 'backed_up'
                """;
            using var reader = files.ExecuteReader();
            reader.Read();
            return new BackupOverview
            {
                ProtectedFolders = folders,
                FilesBackedUp = reader.IsDBNull(0) ? 0 : reader.GetInt64(0),
                BackupBytes = reader.IsDBNull(1) ? 0 : reader.GetInt64(1),
                LastBackupAt = reader.IsDBNull(2) ? null : DateTimeOffset.Parse(reader.GetString(2)),
            };
        }
    }

    public string? CachedFolder(string server, string path)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT folder_id FROM remote_folders WHERE server = $server AND path = $path";
            command.Parameters.AddWithValue("$server", server);
            command.Parameters.AddWithValue("$path", path);
            return command.ExecuteScalar() as string;
        }
    }

    public void CacheFolder(string server, string path, string folderId)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO remote_folders(server, path, folder_id) VALUES($server, $path, $id)
                ON CONFLICT(server, path) DO UPDATE SET folder_id = excluded.folder_id
                """;
            command.Parameters.AddWithValue("$server", server);
            command.Parameters.AddWithValue("$path", path);
            command.Parameters.AddWithValue("$id", folderId);
            command.ExecuteNonQuery();
        }
    }

    public void ClearFolderCache()
    {
        lock (_gate)
        {
            Execute("DELETE FROM remote_folders");
        }
    }

    public IReadOnlyList<FileIndexRow> ListBackedUp(string? jobId)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = jobId == null
                ? "SELECT * FROM file_index WHERE status = 'backed_up'"
                : "SELECT * FROM file_index WHERE status = 'backed_up' AND job_id = $job";
            if (jobId != null)
            {
                command.Parameters.AddWithValue("$job", jobId);
            }

            return ReadIndexList(command);
        }
    }

    private void Initialize()
    {
        using var command = _connection.CreateCommand();
        command.CommandText =
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              document TEXT NOT NULL,
              bound_server TEXT NOT NULL,
              paused INTEGER NOT NULL,
              scan_generation INTEGER NOT NULL,
              last_scan_at TEXT,
              status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS file_index (
              job_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_unix_ms INTEGER NOT NULL,
              content_hash TEXT,
              remote_file_id TEXT,
              remote_version_id TEXT,
              remote_checksum TEXT,
              last_backup_at TEXT,
              status TEXT NOT NULL,
              seen_generation INTEGER NOT NULL,
              delete_after TEXT,
              PRIMARY KEY (job_id, relative_path)
            );
            CREATE TABLE IF NOT EXISTS upload_queue (
              id TEXT PRIMARY KEY,
              job_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              full_path TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_unix_ms INTEGER NOT NULL,
              state TEXT NOT NULL,
              bytes_sent INTEGER NOT NULL,
              remote_upload_id TEXT,
              remote_parent_id TEXT,
              existing_file_id TEXT,
              content_hash TEXT,
              error TEXT,
              retry_count INTEGER NOT NULL,
              next_retry_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              at TEXT NOT NULL,
              kind TEXT NOT NULL,
              path TEXT NOT NULL,
              reason TEXT,
              job_id TEXT
            );
            CREATE TABLE IF NOT EXISTS logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              at TEXT NOT NULL,
              level TEXT NOT NULL,
              message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notifications (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS remote_folders (
              server TEXT NOT NULL,
              path TEXT NOT NULL,
              folder_id TEXT NOT NULL,
              PRIMARY KEY (server, path)
            );
            """;
        command.ExecuteNonQuery();
    }

    private T? GetJson<T>(string key)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key";
            command.Parameters.AddWithValue("$key", key);
            var json = command.ExecuteScalar() as string;
            return json == null ? default : JsonSerializer.Deserialize<T>(json, JsonOpts.Store);
        }
    }

    private void PutJson<T>(string key, T value)
    {
        lock (_gate)
        {
            using var command = _connection.CreateCommand();
            command.CommandText = "INSERT INTO meta(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(value, JsonOpts.Store));
            command.ExecuteNonQuery();
        }
    }

    private BackupJob? GetJobUnlocked(string id)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = "SELECT document FROM jobs WHERE id = $id";
        command.Parameters.AddWithValue("$id", id);
        var json = command.ExecuteScalar() as string;
        return json == null ? null : JsonSerializer.Deserialize<BackupJob>(json, JsonOpts.Store);
    }

    private void SaveJobUnlocked(BackupJob job)
    {
        using var command = _connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO jobs(id, document, bound_server, paused, scan_generation, last_scan_at, status)
            VALUES($id, $document, $server, $paused, $generation, $scan, $status)
            ON CONFLICT(id) DO UPDATE SET
              document = excluded.document,
              bound_server = excluded.bound_server,
              paused = excluded.paused,
              scan_generation = excluded.scan_generation,
              last_scan_at = excluded.last_scan_at,
              status = excluded.status
            """;
        BindJob(command, job);
        command.ExecuteNonQuery();
    }

    private void SaveQueueUnlocked(UploadItem item)
    {
        item.UpdatedAt = DateTimeOffset.UtcNow;
        using var command = _connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO upload_queue(
              id, job_id, relative_path, full_path, file_size, modified_unix_ms, state, bytes_sent,
              remote_upload_id, remote_parent_id, existing_file_id, content_hash, error, retry_count,
              next_retry_at, created_at, updated_at)
            VALUES(
              $id, $job, $path, $full, $size, $mtime, $state, $sent, $upload, $parent, $existing, $hash,
              $error, $retry, $next, $created, $updated)
            ON CONFLICT(id) DO UPDATE SET
              full_path = excluded.full_path,
              file_size = excluded.file_size,
              modified_unix_ms = excluded.modified_unix_ms,
              state = excluded.state,
              bytes_sent = excluded.bytes_sent,
              remote_upload_id = excluded.remote_upload_id,
              remote_parent_id = excluded.remote_parent_id,
              existing_file_id = excluded.existing_file_id,
              content_hash = excluded.content_hash,
              error = excluded.error,
              retry_count = excluded.retry_count,
              next_retry_at = excluded.next_retry_at,
              updated_at = excluded.updated_at
            """;
        command.Parameters.AddWithValue("$id", item.Id);
        command.Parameters.AddWithValue("$job", item.JobId);
        command.Parameters.AddWithValue("$path", item.RelativePath);
        command.Parameters.AddWithValue("$full", item.FullPath);
        command.Parameters.AddWithValue("$size", item.FileSize);
        command.Parameters.AddWithValue("$mtime", item.ModifiedUnixMs);
        command.Parameters.AddWithValue("$state", item.State);
        command.Parameters.AddWithValue("$sent", item.BytesSent);
        command.Parameters.AddWithValue("$upload", (object?)item.RemoteUploadId ?? DBNull.Value);
        command.Parameters.AddWithValue("$parent", (object?)item.RemoteParentId ?? DBNull.Value);
        command.Parameters.AddWithValue("$existing", (object?)item.ExistingFileId ?? DBNull.Value);
        command.Parameters.AddWithValue("$hash", (object?)item.ContentHash ?? DBNull.Value);
        command.Parameters.AddWithValue("$error", (object?)item.Error ?? DBNull.Value);
        command.Parameters.AddWithValue("$retry", item.RetryCount);
        command.Parameters.AddWithValue("$next", item.NextRetryAt?.ToString("O") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$created", item.CreatedAt.ToString("O"));
        command.Parameters.AddWithValue("$updated", item.UpdatedAt.ToString("O"));
        command.ExecuteNonQuery();
    }

    private void Execute(string sql, params (string Name, object Value)[] parameters)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        command.ExecuteNonQuery();
    }

    private static void BindJob(SqliteCommand command, BackupJob job)
    {
        command.Parameters.AddWithValue("$id", job.Id);
        command.Parameters.AddWithValue("$document", JsonSerializer.Serialize(job, JsonOpts.Store));
        command.Parameters.AddWithValue("$server", job.BoundServer);
        command.Parameters.AddWithValue("$paused", job.Paused ? 1 : 0);
        command.Parameters.AddWithValue("$generation", job.ScanGeneration);
        command.Parameters.AddWithValue("$scan", job.LastScanAt?.ToString("O") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$status", job.Status);
    }

    private static void BindIndex(SqliteCommand command, FileIndexRow row)
    {
        command.Parameters.AddWithValue("$job", row.JobId);
        command.Parameters.AddWithValue("$path", row.RelativePath);
        command.Parameters.AddWithValue("$size", row.FileSize);
        command.Parameters.AddWithValue("$mtime", row.ModifiedUnixMs);
        command.Parameters.AddWithValue("$hash", (object?)row.ContentHash ?? DBNull.Value);
        command.Parameters.AddWithValue("$file", (object?)row.RemoteFileId ?? DBNull.Value);
        command.Parameters.AddWithValue("$version", (object?)row.RemoteVersionId ?? DBNull.Value);
        command.Parameters.AddWithValue("$checksum", (object?)row.RemoteChecksum ?? DBNull.Value);
        command.Parameters.AddWithValue("$backup", row.LastBackupAt?.ToString("O") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$status", row.Status);
        command.Parameters.AddWithValue("$seen", row.SeenGeneration);
        command.Parameters.AddWithValue("$delete", row.DeleteAfter?.ToString("O") ?? (object)DBNull.Value);
    }

    private static List<FileIndexRow> ReadIndexList(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<FileIndexRow>();
        while (reader.Read())
        {
            rows.Add(ReadIndex(reader));
        }

        return rows;
    }

    private static FileIndexRow ReadIndex(SqliteDataReader reader) => new()
    {
        JobId = reader.GetString(reader.GetOrdinal("job_id")),
        RelativePath = reader.GetString(reader.GetOrdinal("relative_path")),
        FileSize = reader.GetInt64(reader.GetOrdinal("file_size")),
        ModifiedUnixMs = reader.GetInt64(reader.GetOrdinal("modified_unix_ms")),
        ContentHash = Optional(reader, "content_hash"),
        RemoteFileId = Optional(reader, "remote_file_id"),
        RemoteVersionId = Optional(reader, "remote_version_id"),
        RemoteChecksum = Optional(reader, "remote_checksum"),
        LastBackupAt = OptionalTime(reader, "last_backup_at"),
        Status = reader.GetString(reader.GetOrdinal("status")),
        SeenGeneration = reader.GetInt64(reader.GetOrdinal("seen_generation")),
        DeleteAfter = OptionalTime(reader, "delete_after"),
    };

    private static List<UploadItem> ReadQueueList(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var items = new List<UploadItem>();
        while (reader.Read())
        {
            items.Add(ReadQueue(reader));
        }

        return items;
    }

    private static UploadItem ReadQueue(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(reader.GetOrdinal("id")),
        JobId = reader.GetString(reader.GetOrdinal("job_id")),
        RelativePath = reader.GetString(reader.GetOrdinal("relative_path")),
        FullPath = reader.GetString(reader.GetOrdinal("full_path")),
        FileSize = reader.GetInt64(reader.GetOrdinal("file_size")),
        ModifiedUnixMs = reader.GetInt64(reader.GetOrdinal("modified_unix_ms")),
        State = reader.GetString(reader.GetOrdinal("state")),
        BytesSent = reader.GetInt64(reader.GetOrdinal("bytes_sent")),
        RemoteUploadId = Optional(reader, "remote_upload_id"),
        RemoteParentId = Optional(reader, "remote_parent_id"),
        ExistingFileId = Optional(reader, "existing_file_id"),
        ContentHash = Optional(reader, "content_hash"),
        Error = Optional(reader, "error"),
        RetryCount = reader.GetInt32(reader.GetOrdinal("retry_count")),
        NextRetryAt = OptionalTime(reader, "next_retry_at"),
        CreatedAt = DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("created_at"))),
        UpdatedAt = DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("updated_at"))),
    };

    private static string? Optional(SqliteDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static DateTimeOffset? OptionalTime(SqliteDataReader reader, string name)
    {
        var value = Optional(reader, name);
        return value == null ? null : DateTimeOffset.Parse(value);
    }

    private static int ReadInt(SqliteDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? 0 : Convert.ToInt32(reader.GetValue(ordinal));

    private static long ReadLong(SqliteDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? 0 : Convert.ToInt64(reader.GetValue(ordinal));
}
