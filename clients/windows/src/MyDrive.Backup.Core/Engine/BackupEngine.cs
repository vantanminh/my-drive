namespace MyDrive.Backup;

public sealed class ManualClock : IClock
{
    public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class RunReport
{
    private int _uploaded;
    private int _skipped;
    private int _failed;
    private int _hashed;
    private long _bytes;

    public int Uploaded => _uploaded;

    public int Skipped => _skipped;

    public int Failed => _failed;

    public int Hashed => _hashed;

    public long Bytes => _bytes;

    public bool Paused { get; set; }

    public string? PauseReason { get; set; }

    public void AddUploaded(long bytes)
    {
        Interlocked.Increment(ref _uploaded);
        Interlocked.Add(ref _bytes, bytes);
    }

    public void AddSkipped() => Interlocked.Increment(ref _skipped);

    public void AddFailed() => Interlocked.Increment(ref _failed);

    public void AddHashed() => Interlocked.Increment(ref _hashed);
}

public sealed class AuthorizationState
{
    public string State { get; set; } = "idle";

    public string? UserCode { get; set; }

    public string? VerificationUri { get; set; }

    public string? Detail { get; set; }
}

public sealed class BackupEngine : IDisposable
{
    private readonly LocalDatabase _database;
    private readonly ISecretStore _secrets;
    private readonly IClock _clock;
    private readonly INotifier _notifier;
    private readonly INetworkMonitor _network;
    private readonly IContentHasher _hasher;
    private readonly Func<ServerProfile, IDriveApi> _apis;
    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly HashSet<string> _force = new(StringComparer.Ordinal);
    private readonly TransferMeter _meter = new();
    private readonly object _liveGate = new();
    private readonly Dictionary<string, long> _liveBytes = new(StringComparer.Ordinal);
    private readonly object _state = new();
    private AuthorizationState _authorization = new();
    private string? _deviceCode;
    private DateTimeOffset _nextPoll;
    private bool _backupAll;
    private bool _unreachable;
    private bool _watchersDirty = true;
    private DateTimeOffset _lastLiveSave;
    private IDriveApi? _api;
    private string? _apiUrl;
    private bool _disposed;

    public BackupEngine(
        LocalDatabase database,
        ISecretStore secrets,
        IClock? clock = null,
        INotifier? notifier = null,
        INetworkMonitor? network = null,
        IContentHasher? hasher = null,
        Func<ServerProfile, IDriveApi>? apis = null)
    {
        _database = database;
        _secrets = secrets;
        _clock = clock ?? new SystemClock();
        _notifier = notifier ?? new NullNotifier();
        _network = network ?? new NetworkMonitor();
        _hasher = hasher ?? new Sha256Hasher();
        _apis = apis ?? (profile => new RefreshingDriveApi(
            ServerAddress.Normalize(profile.Url, profile.AllowInsecure),
            profile.AllowInsecure,
            secrets));
        _database.AddLog("Info", "Backup engine started");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }

        _watchers.Clear();
        if (_api is IDisposable disposable)
        {
            disposable.Dispose();
        }
    }

    public EngineSnapshot Status()
    {
        var settings = _database.GetSettings();
        var stats = _database.QueueStats();
        var reading = _meter.Read(_clock.UtcNow);
        var transfers = _database.ListQueue();
        lock (_liveGate)
        {
            foreach (var item in transfers)
            {
                if (item.State == QueueState.Uploading
                    && _liveBytes.TryGetValue(item.Id, out var sent)
                    && sent > item.BytesSent)
                {
                    item.BytesSent = sent;
                }
            }
        }

        return new EngineSnapshot
        {
            Running = true,
            Paused = _database.GetFlag("paused"),
            PauseReason = _database.GetFlag("paused") ? "Paused" : null,
            NetworkStatus = Describe(_network.Snapshot()),
            ActiveUploads = transfers.Count(item => item.State == QueueState.Uploading),
            QueueSize = stats.Queue,
            Failed = stats.Failed,
            Retrying = stats.Retrying,
            Workers = TransferLimits.UploadsFor(settings.ConcurrentUploads),
            SessionUploadedBytes = reading.SessionBytes,
            RemainingBytes = stats.Remaining,
            BytesPerSecond = reading.BytesPerSecond,
            SpeedHistory = reading.History,
            TransferSpeeds = reading.TransferSpeeds,
            Server = _database.GetServer(),
            Overview = _database.Overview(),
            Jobs = _database.ListJobs().Select(SnapshotJob).ToArray(),
            Transfers = transfers,
            AuthState = _authorization.State,
            AuthDetail = _authorization.Detail,
            AuthUserCode = _authorization.UserCode,
        };
    }

    public AuthorizationState Authorization => _authorization;

    public IReadOnlyList<BackupJob> Jobs() => _database.ListJobs();

    public ClientSettings Settings() => _database.GetSettings();

    public IReadOnlyList<ActivityEntry> ListActivity(string? kind) => _database.ListActivity(kind);

    public IReadOnlyList<LogEntry> ListLogs() => _database.ListLogs();

    public string ExportLogs() => _database.ExportLogs();

    public void ClearLogs() => _database.ClearLogs();

    public IReadOnlyList<(string Title, string Body)> DrainNotifications() => _database.DrainNotifications();

    public void SaveSettings(ClientSettings settings)
    {
        settings.ConcurrentUploads = TransferLimits.UploadsFor(settings.ConcurrentUploads);
        settings.HashConcurrency = TransferLimits.HashersFor(settings.HashConcurrency);
        settings.ChunkSizeMb = settings.ChunkSizeMb <= 0 ? 0 : Math.Clamp(settings.ChunkSizeMb, 8, 64);
        _database.SaveSettings(settings);
        _watchersDirty = true;
    }

    public void SaveJob(BackupJob job)
    {
        var server = _database.GetServer();
        if (string.IsNullOrWhiteSpace(job.BoundServer))
        {
            job.BoundServer = server?.Url ?? "";
        }

        if (string.IsNullOrWhiteSpace(job.Name))
        {
            job.Name = Path.GetFileName(job.SourcePath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }

        _database.SaveJob(job);
        _watchersDirty = true;
        _database.AddLog("Info", $"Saved backup job {job.Name}");
    }

    public void DeleteJob(string id)
    {
        var job = _database.GetJob(id);
        _database.DeleteJob(id);
        _watchersDirty = true;
        _database.AddLog("Info", $"Removed backup job {job?.Name ?? id}. Cloud files were kept.");
    }

    public void PauseAll()
    {
        _database.SetFlag("paused", true);
        _database.AddLog("Info", "Paused all backups");
    }

    public void ResumeAll()
    {
        _database.SetFlag("paused", false);
        _database.ResumePausedQueue();
        _database.AddLog("Info", "Resumed backups");
    }

    public void PauseJob(string id)
    {
        var job = _database.GetJob(id) ?? throw new InvalidOperationException("Backup job was not found.");
        job.Paused = true;
        job.Status = "paused";
        _database.SaveJob(job);
        _watchersDirty = true;
    }

    public void ResumeJob(string id)
    {
        var job = _database.GetJob(id) ?? throw new InvalidOperationException("Backup job was not found.");
        job.Paused = false;
        job.Status = "idle";
        _database.SaveJob(job);
        _watchersDirty = true;
        _database.ResumePausedQueue();
    }

    public void BackupNow(string? jobId)
    {
        lock (_force)
        {
            if (string.IsNullOrEmpty(jobId))
            {
                _backupAll = true;
            }
            else
            {
                _force.Add(jobId);
            }
        }
    }

    public async Task<ServerProfile> TestServerAsync(string url, bool allowInsecure, CancellationToken cancellationToken)
    {
        var profile = ProbeProfile(url, allowInsecure);
        var api = _apis(profile);
        var capabilities = await api.GetCapabilitiesAsync(cancellationToken);
        ServerAddress.EnsureCompatible(capabilities);
        profile.ApiVersion = capabilities.ApiVersion;
        profile.ServerVersion = capabilities.ServerVersion;
        profile.LastError = capabilities.DeviceAuthorization ? null : "This server does not advertise device authorization.";
        return profile;
    }

    public async Task<ServerProfile> SetServerAsync(string url, bool allowInsecure, bool confirm, CancellationToken cancellationToken)
    {
        var profile = await TestServerAsync(url, allowInsecure, cancellationToken);
        var current = _database.GetServer();
        if (current != null && !string.Equals(current.Url, profile.Url, StringComparison.OrdinalIgnoreCase))
        {
            if (!confirm)
            {
                throw new ConfirmationRequiredException(
                    "Changing the server pauses backup jobs for the current server. Account, backup jobs, and data for that server may not apply to the new server.");
            }

            _secrets.Delete(SecretKeys.Access(current.Url));
            _secrets.Delete(SecretKeys.Refresh(current.Url));
            foreach (var job in _database.ListJobs().Where(job => string.Equals(job.BoundServer, current.Url, StringComparison.OrdinalIgnoreCase)))
            {
                job.Paused = true;
                job.Status = "paused-server";
                _database.SaveJob(job);
            }

            _database.ClearFolderCache();
            DropApi();
        }

        profile.Connected = HasAccess(profile.Url);
        profile.AccountEmail = current != null && string.Equals(current.Url, profile.Url, StringComparison.OrdinalIgnoreCase) ? current.AccountEmail : null;
        profile.DeviceId = current != null && string.Equals(current.Url, profile.Url, StringComparison.OrdinalIgnoreCase) ? current.DeviceId : null;
        _database.SaveServer(profile);
        _database.AddLog("Info", $"Server set to {profile.Name}");
        return profile;
    }

    public async Task<AuthorizationState> BeginAuthorizationAsync(CancellationToken cancellationToken)
    {
        var server = RequireServer();
        var api = ApiFor(server);
        var capabilities = await api.GetCapabilitiesAsync(cancellationToken);
        ServerAddress.EnsureCompatible(capabilities);
        if (!capabilities.DeviceAuthorization)
        {
            throw new InvalidOperationException("This server does not support device authorization.");
        }

        var start = await api.StartDeviceCodeAsync(Environment.MachineName, cancellationToken);
        _deviceCode = start.DeviceCode;
        _nextPoll = _clock.UtcNow;
        var uri = Absolute(server.Url, start.VerificationUriComplete);
        _authorization = new AuthorizationState
        {
            State = "pending",
            UserCode = start.UserCode,
            VerificationUri = uri,
            Detail = "Continue in the browser and approve this device.",
        };
        _database.AddLog("Info", "Started device authorization");
        return _authorization;
    }

    public async Task LogoutAsync(CancellationToken cancellationToken)
    {
        var server = _database.GetServer();
        if (server == null)
        {
            return;
        }

        try
        {
            if (HasAccess(server.Url))
            {
                await ApiFor(server).LogoutAsync(cancellationToken);
            }
        }
        catch (Exception ex) when (ex is ApiException or HttpRequestException or IOException)
        {
            _database.AddLog("Warning", "Server logout did not complete: " + ex.Message);
        }

        _secrets.Delete(SecretKeys.Access(server.Url));
        _secrets.Delete(SecretKeys.Refresh(server.Url));
        server.Connected = false;
        server.AccountEmail = null;
        server.DeviceId = null;
        _database.SaveServer(server);
        _authorization = new AuthorizationState { State = "idle", Detail = "Disconnected" };
        _deviceCode = null;
        DropApi();
        _database.AddLog("Info", "Disconnected from the server");
    }

    public async Task RebuildIndexAsync(bool confirm, CancellationToken cancellationToken)
    {
        if (!confirm)
        {
            throw new ConfirmationRequiredException("Rebuilding the local index does not delete cloud backups. The next scan compares files again.");
        }

        foreach (var job in _database.ListJobs())
        {
            _database.ClearJobIndex(job.Id);
            job.LastScanAt = null;
            job.ScanGeneration = 0;
            _database.SaveJob(job);
        }

        _database.AddLog("Info", "Local index rebuilt");
        await Task.CompletedTask;
    }

    public Task<IReadOnlyList<RemoteVersion>> VersionsAsync(string fileId, CancellationToken cancellationToken)
    {
        var server = RequireServer();
        return ApiFor(server).VersionsAsync(fileId, cancellationToken);
    }

    public async Task VerifyIntegrityAsync(bool confirm, CancellationToken cancellationToken)
    {
        if (!confirm)
        {
            throw new ConfirmationRequiredException("Integrity verification re-reads local files and compares checksums. It does not delete cloud data.");
        }

        var server = RequireServer();
        var api = ApiFor(server);
        foreach (var row in _database.ListBackedUp(null))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var job = _database.GetJob(row.JobId);
            if (job == null)
            {
                continue;
            }

            var full = Path.Combine(job.SourcePath, row.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full))
            {
                _database.AddActivity("Failed", row.RelativePath, "Local file is missing. The cloud backup was kept.", row.JobId);
                continue;
            }

            var hash = await _hasher.HashAsync(full, cancellationToken);
            if (!string.IsNullOrEmpty(row.RemoteChecksum) && !hash.Equals(row.RemoteChecksum, StringComparison.OrdinalIgnoreCase))
            {
                _database.Enqueue(new UploadItem
                {
                    JobId = row.JobId,
                    RelativePath = row.RelativePath,
                    FullPath = full,
                    FileSize = new FileInfo(full).Length,
                    ModifiedUnixMs = row.ModifiedUnixMs,
                    ContentHash = hash,
                    ExistingFileId = row.RemoteFileId,
                    State = QueueState.Waiting,
                });
                _database.AddActivity("Failed", row.RelativePath, "Checksum did not match. The file was queued again.", row.JobId);
            }
        }

        _database.AddLog("Info", "Integrity verification finished");
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                RefreshWatchers();
                await RunOnceAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _database.AddLog("Error", ex.Message);
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public async Task<RunReport> RunOnceAsync(CancellationToken cancellationToken)
    {
        var report = new RunReport();
        var settings = _database.GetSettings();
        var server = _database.GetServer();
        if (server != null)
        {
            await TryPollAuthorizationAsync(server, cancellationToken);
        }

        if (_database.GetFlag("paused"))
        {
            report.Paused = true;
            report.PauseReason = "Paused";
            return report;
        }

        if (server is not { Connected: true })
        {
            report.Paused = true;
            report.PauseReason = "Sign in required";
            return report;
        }

        var snapshot = _network.Snapshot();
        if (!NetworkPolicy.AllowsUpload(settings, snapshot))
        {
            report.Paused = true;
            report.PauseReason = snapshot.MeteredKnown && snapshot.Metered ? "Metered network" : "Waiting for an allowed network";
            return report;
        }

        IDriveApi api;
        ServerCapabilities capabilities;
        try
        {
            api = ApiFor(server);
            capabilities = await api.GetCapabilitiesAsync(cancellationToken);
            ServerAddress.EnsureCompatible(capabilities);
            if (_unreachable)
            {
                _unreachable = false;
                Notify("Connection restored", "Resuming backup");
                _database.AddLog("Info", "Connection restored. Resuming backup.");
            }
        }
        catch (ServerCompatibilityException)
        {
            report.Paused = true;
            report.PauseReason = "This server is using an API version that is not supported by this client.";
            _database.AddLog("Error", report.PauseReason);
            return report;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TimeoutException or ApiException)
        {
            report.Paused = true;
            report.PauseReason = "Server unreachable";
            if (!_unreachable)
            {
                _unreachable = true;
                Notify("Backup interrupted", "Server unreachable.\n\nBackup will resume automatically.");
                _database.AddLog("Warning", "Server unreachable. Backup paused automatically.");
            }

            return report;
        }

        _database.ResetInterrupted();
        await ApplyDueDeletionsAsync(api, cancellationToken);
        var forced = TakeForce();
        foreach (var job in _database.ListJobs())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!string.Equals(job.BoundServer, server.Url, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!SchedulePolicy.IsDue(job, _clock.UtcNow, forced.Contains(job.Id)))
            {
                continue;
            }

            await ScanJobAsync(job, settings, api, capabilities, server, report, cancellationToken);
        }

        await DrainAsync(settings, api, capabilities, server, report, cancellationToken);
        if (report.Uploaded > 0)
        {
            Notify("Backup completed", $"{ByteFormat.Format(report.Bytes)}\n{report.Uploaded} files\n\nCompleted successfully");
        }

        try
        {
            var account = await api.GetAccountAsync(cancellationToken);
            var storage = await api.GetStorageAsync(cancellationToken);
            server.AccountEmail = account.Email;
            server.Connected = true;
            server.LastError = null;
            _database.SaveServer(server);
            lock (_state)
            {
                _lastStorage = storage;
            }
        }
        catch (Exception ex) when (ex is ApiException or HttpRequestException or IOException)
        {
            _database.AddLog("Warning", "Could not refresh account status: " + ex.Message);
        }

        return report;
    }

    public StorageQuota? LastStorage
    {
        get
        {
            lock (_state)
            {
                return _lastStorage;
            }
        }
    }

    private StorageQuota? _lastStorage;

    private async Task ScanJobAsync(
        BackupJob job,
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        RunReport report,
        CancellationToken cancellationToken)
    {
        if (!Directory.Exists(job.SourcePath))
        {
            job.Status = "missing-folder";
            job.LastScanAt = _clock.UtcNow;
            _database.SaveJob(job);
            _database.AddLog("Warning", $"Folder is missing for {job.Name}");
            return;
        }

        job.Status = "scanning";
        _database.SaveJob(job);
        var generation = _database.NextScanGeneration(job.Id);
        job.ScanGeneration = generation;
        var degree = TransferLimits.HashersFor(settings.HashConcurrency);
        var batch = new List<ScannedFile>(64);
        foreach (var file in FileScanner.Enumerate(job.SourcePath, job, settings, cancellationToken))
        {
            batch.Add(file);
            if (batch.Count >= 64)
            {
                await ProcessBatchAsync(batch, job, settings, api, capabilities, server, generation, degree, report, cancellationToken);
                batch.Clear();
            }
        }

        if (batch.Count > 0)
        {
            await ProcessBatchAsync(batch, job, settings, api, capabilities, server, generation, degree, report, cancellationToken);
        }

        _database.DeleteSettling(job.Id, generation);
        await ResolveMissingAsync(job, api, server, generation, report, cancellationToken);
        job.LastScanAt = _clock.UtcNow;
        job.LastSuccessAt = report.Failed == 0 ? _clock.UtcNow : job.LastSuccessAt;
        job.Status = job.Paused ? "paused" : "idle";
        _database.SaveJob(job);
    }

    private async Task ProcessBatchAsync(
        List<ScannedFile> batch,
        BackupJob job,
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        long generation,
        int degree,
        RunReport report,
        CancellationToken cancellationToken)
    {
        await Parallel.ForEachAsync(batch, new ParallelOptions { MaxDegreeOfParallelism = degree, CancellationToken = cancellationToken }, async (file, token) =>
        {
            await ConsiderFileAsync(file, job, settings, api, capabilities, server, generation, report, token);
        });
    }

    private async Task ConsiderFileAsync(
        ScannedFile file,
        BackupJob job,
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        long generation,
        RunReport report,
        CancellationToken cancellationToken)
    {
        var existing = _database.FindIndex(job.Id, file.RelativePath);
        if (existing != null
            && existing.FileSize == file.Size
            && existing.ModifiedUnixMs == file.ModifiedUnixMs
            && !string.IsNullOrEmpty(existing.ContentHash)
            && existing.RemoteFileId != null
            && existing.Status is "backed_up" or "local_missing" or "delete_scheduled")
        {
            existing.Status = "backed_up";
            existing.DeleteAfter = null;
            existing.SeenGeneration = generation;
            _database.UpsertIndex(existing);
            report.AddSkipped();
            return;
        }

        if (!IsStable(file, settings))
        {
            _database.UpsertIndex(new FileIndexRow
            {
                JobId = job.Id,
                RelativePath = file.RelativePath,
                FileSize = file.Size,
                ModifiedUnixMs = file.ModifiedUnixMs,
                ContentHash = existing?.ContentHash,
                RemoteFileId = existing?.RemoteFileId,
                RemoteVersionId = existing?.RemoteVersionId,
                RemoteChecksum = existing?.RemoteChecksum,
                Status = "settling",
                SeenGeneration = generation,
            });
            return;
        }

        var hash = await _hasher.HashAsync(file.FullPath, cancellationToken);
        report.AddHashed();
        if (existing != null
            && string.Equals(existing.ContentHash, hash, StringComparison.OrdinalIgnoreCase)
            && existing.RemoteFileId != null
            && existing.Status is "backed_up" or "local_missing" or "delete_scheduled")
        {
            existing.FileSize = file.Size;
            existing.ModifiedUnixMs = file.ModifiedUnixMs;
            existing.Status = "backed_up";
            existing.DeleteAfter = null;
            existing.SeenGeneration = generation;
            existing.LastBackupAt = _clock.UtcNow;
            _database.UpsertIndex(existing);
            _database.AddActivity("Skipped", file.RelativePath, "File unchanged", job.Id);
            report.AddSkipped();
            return;
        }

        var row = existing ?? new FileIndexRow { JobId = job.Id, RelativePath = file.RelativePath };
        row.FileSize = file.Size;
        row.ModifiedUnixMs = file.ModifiedUnixMs;
        row.ContentHash = hash;
        row.SeenGeneration = generation;
        row.Status = "pending";
        _database.UpsertIndex(row);

        var directory = Path.GetDirectoryName(file.RelativePath)?.Replace('\\', '/');
        var parent = await FolderAsync(api, server.Url, RemotePath.Combine(job.Destination, directory), cancellationToken);
        var check = await api.CheckAsync(parent, file.Name, file.Size, hash, cancellationToken);
        if (check.Action == "skip")
        {
            MarkBackedUp(row, check.FileId, check.VersionId, check.RemoteChecksum ?? hash, generation);
            _database.AddActivity("Skipped", file.RelativePath, "File unchanged", job.Id);
            report.AddSkipped();
            return;
        }

        if (check.Action == "link" && capabilities.Deduplication)
        {
            var link = await api.LinkAsync(parent, file.Name, file.Size, hash, DateTimeOffset.FromUnixTimeMilliseconds(file.ModifiedUnixMs), cancellationToken);
            MarkBackedUp(row, link.FileId, link.VersionId, link.Checksum, generation);
            if (link.Unchanged)
            {
                _database.AddActivity("Skipped", file.RelativePath, "File unchanged", job.Id);
                report.AddSkipped();
            }
            else
            {
                _database.AddActivity("Uploaded", file.RelativePath, "Linked existing content", job.Id);
                report.AddUploaded(file.Size);
                _meter.CorrectSession(file.Size);
            }

            return;
        }

        row.RemoteFileId = check.FileId ?? row.RemoteFileId;
        _database.UpsertIndex(row);
        _database.Enqueue(new UploadItem
        {
            JobId = job.Id,
            RelativePath = file.RelativePath,
            FullPath = file.FullPath,
            FileSize = file.Size,
            ModifiedUnixMs = file.ModifiedUnixMs,
            ContentHash = hash,
            RemoteParentId = parent,
            ExistingFileId = check.FileId,
            State = QueueState.Waiting,
        });
    }

    private async Task ResolveMissingAsync(BackupJob job, IDriveApi api, ServerProfile server, long generation, RunReport report, CancellationToken cancellationToken)
    {
        foreach (var missing in _database.ListUnseen(job.Id, generation))
        {
            cancellationToken.ThrowIfCancellationRequested();
            FileIndexRow? moved = null;
            if (!string.IsNullOrEmpty(missing.ContentHash) && missing.RemoteFileId != null)
            {
                moved = _database.ListByHash(job.Id, missing.ContentHash, missing.FileSize, generation)
                    .FirstOrDefault(row => row.RelativePath != missing.RelativePath && row.RemoteFileId == null);
            }

            if (moved != null && missing.RemoteFileId != null)
            {
                await MoveRemoteAsync(api, server, job, missing, moved, cancellationToken);
                _database.AddActivity("Skipped", moved.RelativePath, "Moved with the local file", job.Id);
                report.AddSkipped();
                continue;
            }

            await ApplyDeletionAsync(api, job, missing, generation, cancellationToken);
        }
    }

    private async Task MoveRemoteAsync(IDriveApi api, ServerProfile server, BackupJob job, FileIndexRow missing, FileIndexRow moved, CancellationToken cancellationToken)
    {
        var oldDirectory = Path.GetDirectoryName(missing.RelativePath)?.Replace('\\', '/');
        var newDirectory = Path.GetDirectoryName(moved.RelativePath)?.Replace('\\', '/');
        var oldName = Path.GetFileName(missing.RelativePath);
        var newName = Path.GetFileName(moved.RelativePath);
        if (!string.Equals(oldDirectory, newDirectory, StringComparison.OrdinalIgnoreCase))
        {
            var parent = await FolderAsync(api, server.Url, RemotePath.Combine(job.Destination, newDirectory), cancellationToken);
            await api.MoveAsync(missing.RemoteFileId!, parent, cancellationToken);
        }

        if (!string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase))
        {
            await api.RenameAsync(missing.RemoteFileId!, newName, cancellationToken);
        }

        moved.RemoteFileId = missing.RemoteFileId;
        moved.RemoteVersionId = missing.RemoteVersionId;
        moved.RemoteChecksum = missing.RemoteChecksum ?? missing.ContentHash;
        moved.Status = "backed_up";
        moved.LastBackupAt = _clock.UtcNow;
        _database.UpsertIndex(moved);
        _database.DeleteIndex(job.Id, missing.RelativePath);
        _database.FinishQueued(job.Id, moved.RelativePath, QueueState.Skipped, "Moved with the local file");
    }

    private async Task ApplyDeletionAsync(IDriveApi api, BackupJob job, FileIndexRow row, long generation, CancellationToken cancellationToken)
    {
        row.SeenGeneration = generation;
        if (job.DeletionPolicy == DeletionPolicies.Trash && row.RemoteFileId != null)
        {
            await api.TrashAsync(row.RemoteFileId, cancellationToken);
            row.Status = "deleted";
            _database.UpsertIndex(row);
            _database.AddActivity("Deleted", row.RelativePath, "Moved cloud copy to trash", job.Id);
            return;
        }

        if (job.DeletionPolicy == DeletionPolicies.Delay && row.RemoteFileId != null)
        {
            row.Status = "delete_scheduled";
            row.DeleteAfter = _clock.UtcNow.AddDays(Math.Max(1, job.DeletionDelayDays));
            _database.UpsertIndex(row);
            _database.AddActivity("Deleted", row.RelativePath, $"Cloud copy will be removed after {job.DeletionDelayDays} days", job.Id);
            return;
        }

        row.Status = "local_missing";
        row.DeleteAfter = null;
        _database.UpsertIndex(row);
        _database.AddActivity("Skipped", row.RelativePath, "Local file deleted; cloud backup kept", job.Id);
    }

    private async Task ApplyDueDeletionsAsync(IDriveApi api, CancellationToken cancellationToken)
    {
        foreach (var row in _database.ListDueDeletions(_clock.UtcNow))
        {
            var job = _database.GetJob(row.JobId);
            if (job == null || job.DeletionPolicy == DeletionPolicies.Keep || row.RemoteFileId == null)
            {
                row.DeleteAfter = null;
                row.Status = "local_missing";
                _database.UpsertIndex(row);
                continue;
            }

            await api.TrashAsync(row.RemoteFileId, cancellationToken);
            row.Status = "deleted";
            row.DeleteAfter = null;
            _database.UpsertIndex(row);
            _database.AddActivity("Deleted", row.RelativePath, "Removed cloud copy after the delay", row.JobId);
        }
    }

    private async Task DrainAsync(
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        RunReport report,
        CancellationToken cancellationToken)
    {
        var workers = TransferLimits.UploadsFor(settings.ConcurrentUploads);
        var tasks = new List<Task>();
        for (var i = 0; i < workers; i++)
        {
            tasks.Add(WorkerAsync(settings, api, capabilities, server, report, cancellationToken));
        }

        await Task.WhenAll(tasks);
    }

    private async Task WorkerAsync(
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        RunReport report,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && !_database.GetFlag("paused"))
        {
            var item = _database.ClaimNext(_clock.UtcNow);
            if (item == null)
            {
                return;
            }

            await TransferAsync(item, settings, api, capabilities, server, report, cancellationToken);
        }
    }

    private async Task TransferAsync(
        UploadItem item,
        ClientSettings settings,
        IDriveApi api,
        ServerCapabilities capabilities,
        ServerProfile server,
        RunReport report,
        CancellationToken cancellationToken)
    {
        var noted = new long[1];
        try
        {
            var job = _database.GetJob(item.JobId);
            if (job == null || job.Paused)
            {
                item.State = QueueState.Paused;
                _database.SaveQueue(item);
                return;
            }

            if (!File.Exists(item.FullPath))
            {
                item.State = QueueState.Skipped;
                item.Error = "Local file is gone";
                _database.SaveQueue(item);
                return;
            }

            var scanned = new ScannedFile(item.FullPath, item.RelativePath, Path.GetFileName(item.RelativePath), item.FileSize, item.ModifiedUnixMs, false, false, false);
            if (!IsStable(scanned, settings))
            {
                item.State = QueueState.Waiting;
                item.NextRetryAt = _clock.UtcNow.AddSeconds(Math.Max(1, settings.StabilitySeconds));
                item.Error = "File is still changing";
                _database.SaveQueue(item);
                return;
            }

            if (string.IsNullOrEmpty(item.ContentHash))
            {
                item.State = QueueState.Hashing;
                _database.SaveQueue(item);
                item.ContentHash = await _hasher.HashAsync(item.FullPath, cancellationToken);
                item.FileSize = new FileInfo(item.FullPath).Length;
            }

            if (string.IsNullOrEmpty(item.RemoteParentId))
            {
                item.State = QueueState.CheckingServer;
                _database.SaveQueue(item);
                var directory = Path.GetDirectoryName(item.RelativePath)?.Replace('\\', '/');
                item.RemoteParentId = await FolderAsync(api, server.Url, RemotePath.Combine(job.Destination, directory), cancellationToken);
            }

            var chunkBytes = TransferLimits.ChunkBytes(settings, capabilities);
            if (item.FileSize > chunkBytes && !capabilities.ChunkedUpload)
            {
                throw new ApiException(413, "chunked_upload_unsupported", message: "This server cannot accept this file in chunks.");
            }

            if (string.IsNullOrEmpty(item.RemoteUploadId))
            {
                var created = await api.CreateUploadAsync(
                    Path.GetFileName(item.RelativePath),
                    item.FileSize,
                    item.RemoteParentId,
                    item.ExistingFileId,
                    DateTimeOffset.FromUnixTimeMilliseconds(item.ModifiedUnixMs),
                    cancellationToken);
                item.RemoteUploadId = created.Id;
                item.BytesSent = created.Offset;
                _database.SaveQueue(item);
            }
            else if (capabilities.ResumableUpload)
            {
                item.BytesSent = await api.HeadOffsetAsync(item.RemoteUploadId, cancellationToken);
            }

            item.State = QueueState.Uploading;
            _database.SaveQueue(item);
            var limit = BandwidthPolicy.EffectiveLimit(settings, _clock.UtcNow.ToLocalTime());
            var buffer = new byte[chunkBytes];
            while (item.BytesSent < item.FileSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_database.GetFlag("paused") || (_database.GetJob(item.JobId)?.Paused ?? true))
                {
                    item.State = QueueState.Paused;
                    _database.SaveQueue(item);
                    return;
                }

                var count = await ReadSliceAsync(item.FullPath, item.BytesSent, buffer, cancellationToken);
                if (count <= 0)
                {
                    break;
                }

                var before = item.BytesSent;
                noted[0] = 0;
                try
                {
                    var next = await api.PatchAsync(
                        item.RemoteUploadId,
                        before,
                        buffer,
                        count,
                        cancellationToken,
                        sent => NoteUpload(item, before, noted, sent));
                    var acknowledged = Math.Max(0, next - before);
                    if (noted[0] == 0)
                    {
                        _meter.Add(_clock.UtcNow, acknowledged, item.Id);
                    }
                    else if (noted[0] != acknowledged)
                    {
                        _meter.CorrectSession(acknowledged - noted[0]);
                    }

                    noted[0] = 0;
                    item.BytesSent = next;
                    PublishLive(item, next, force: true);
                }
                catch (ApiException ex) when (ex.Status == 409 && ex.Offset is long serverOffset)
                {
                    _meter.CorrectSession(-noted[0]);
                    noted[0] = 0;
                    item.BytesSent = serverOffset;
                    PublishLive(item, serverOffset, force: true);
                }

                _database.SaveQueue(item);
                await PaceAsync(count, limit, cancellationToken);
            }

            var finalized = await api.FinalizeAsync(item.RemoteUploadId!, item.ContentHash!, cancellationToken);
            if (!string.IsNullOrEmpty(finalized.Checksum)
                && !finalized.Checksum.Equals(item.ContentHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new ApiException(409, "checksum_mismatch", message: "Local hash does not match the remote hash.");
            }

            var index = _database.FindIndex(item.JobId, item.RelativePath) ?? new FileIndexRow
            {
                JobId = item.JobId,
                RelativePath = item.RelativePath,
            };
            MarkBackedUp(index, finalized.FileId, finalized.VersionId, finalized.Checksum ?? item.ContentHash, index.SeenGeneration);
            item.State = QueueState.Completed;
            item.Error = null;
            item.BytesSent = item.FileSize;
            _database.SaveQueue(item);
            ForgetLive(item.Id);
            _database.AddActivity("Uploaded", item.RelativePath, null, item.JobId);
            report.AddUploaded(item.FileSize);
            var current = _database.GetJob(item.JobId);
            if (current != null)
            {
                current.LastSuccessAt = _clock.UtcNow;
                current.Status = "idle";
                _database.SaveJob(current);
            }
        }
        catch (OperationCanceledException)
        {
            _meter.CorrectSession(-noted[0]);
            item.State = QueueState.Waiting;
            _database.SaveQueue(item);
            throw;
        }
        catch (Exception ex)
        {
            _meter.CorrectSession(-noted[0]);
            ForgetLive(item.Id);
            HandleFailure(item, settings, capabilities, ex, report);
        }
    }

    private void NoteUpload(UploadItem item, long before, long[] noted, int sent)
    {
        if (sent <= 0)
        {
            return;
        }

        noted[0] += sent;
        _meter.Add(_clock.UtcNow, sent, item.Id);
        PublishLive(item, before + noted[0], force: false);
    }

    private void PublishLive(UploadItem item, long sent, bool force)
    {
        var save = force;
        lock (_liveGate)
        {
            _liveBytes[item.Id] = sent;
            var now = _clock.UtcNow;
            if (!save && now - _lastLiveSave >= TimeSpan.FromMilliseconds(200))
            {
                _lastLiveSave = now;
                save = true;
            }
            else if (save)
            {
                _lastLiveSave = now;
            }
        }

        if (!save)
        {
            return;
        }

        item.BytesSent = sent;
        _database.SaveQueue(item);
    }

    private void ForgetLive(string id)
    {
        lock (_liveGate)
        {
            _liveBytes.Remove(id);
        }
    }

    private void HandleFailure(UploadItem item, ClientSettings settings, ServerCapabilities capabilities, Exception exception, RunReport report)
    {
        var kind = RetryPolicy.Classify(exception);
        item.Error = exception is ApiException api ? api.Code : "Connection lost";
        var retry = kind is FailureKind.Retry or FailureKind.Network or FailureKind.RateLimit;
        var stop = kind is FailureKind.Permission or FailureKind.Missing or FailureKind.Fatal;
        if (exception is ApiException mismatch && mismatch.Code is "checksum_mismatch" or "gone")
        {
            item.RemoteUploadId = null;
            item.BytesSent = 0;
            retry = true;
            stop = false;
        }

        if (!capabilities.ResumableUpload)
        {
            item.RemoteUploadId = null;
            item.BytesSent = 0;
        }

        if (!retry || item.RetryCount >= settings.RetryLimit || stop)
        {
            item.State = QueueState.Failed;
            _database.SaveQueue(item);
            _database.AddActivity("Failed", item.RelativePath, item.Error, item.JobId);
            _database.AddLog("Error", $"Upload failed for {item.RelativePath}: {item.Error}");
            report.AddFailed();
            return;
        }

        item.RetryCount++;
        item.State = QueueState.Retrying;
        var delay = exception is ApiException { Status: 429, Interval: int seconds }
            ? TimeSpan.FromSeconds(Math.Max(1, seconds))
            : RetryPolicy.Delay(item.RetryCount - 1);
        item.NextRetryAt = _clock.UtcNow.Add(delay);
        _database.SaveQueue(item);
        _database.AddLog("Warning", $"Retrying {item.RelativePath} after {delay.TotalSeconds:0}s ({item.Error})");
    }

    private async Task TryPollAuthorizationAsync(ServerProfile server, CancellationToken cancellationToken)
    {
        if (_authorization.State != "pending" || string.IsNullOrEmpty(_deviceCode))
        {
            return;
        }

        try
        {
            await PollAuthorizationAsync(ApiFor(server), server, cancellationToken);
        }
        catch (Exception ex) when (ex is ApiException or HttpRequestException or IOException or TimeoutException)
        {
            _nextPoll = _clock.UtcNow.AddSeconds(5);
            _database.AddLog("Warning", "Device authorization is still waiting: " + ex.Message);
        }
    }

    private async Task PollAuthorizationAsync(IDriveApi api, ServerProfile server, CancellationToken cancellationToken)
    {
        if (_authorization.State != "pending" || string.IsNullOrEmpty(_deviceCode) || _clock.UtcNow < _nextPoll)
        {
            return;
        }

        var poll = await api.PollDeviceCodeAsync(_deviceCode, cancellationToken);
        _nextPoll = _clock.UtcNow.AddSeconds(Math.Max(1, poll.IntervalSeconds));
        if (poll.Authorized && poll.Tokens != null)
        {
            _secrets.Save(SecretKeys.Access(server.Url), poll.Tokens.AccessToken);
            _secrets.Save(SecretKeys.Refresh(server.Url), poll.Tokens.RefreshToken);
            server.Connected = true;
            server.DeviceId = poll.Tokens.DeviceId;
            server.LastError = null;
            _deviceCode = null;
            DropApi();
            try
            {
                server.AccountEmail = (await ApiFor(server).GetAccountAsync(cancellationToken)).Email;
            }
            catch (Exception ex) when (ex is ApiException or HttpRequestException or IOException or TimeoutException)
            {
                _database.AddLog("Warning", "Device authorized, but the account profile was not loaded: " + ex.Message);
            }

            _database.SaveServer(server);
            _authorization = new AuthorizationState
            {
                State = "authorized",
                Detail = server.AccountEmail,
            };
            _database.AddLog("Info", "Device authorized");
            Notify("Device authorized", string.IsNullOrEmpty(server.AccountEmail)
                ? "This PC can back up to your account."
                : server.AccountEmail);
            return;
        }

        if (poll.Denied || poll.Expired || (!poll.Pending && poll.Error != null))
        {
            _deviceCode = null;
            _authorization = new AuthorizationState
            {
                State = poll.Denied ? "denied" : poll.Expired ? "expired" : "error",
                Detail = poll.Error,
            };
        }
    }

    private void MarkBackedUp(FileIndexRow row, string? fileId, string? versionId, string? checksum, long generation)
    {
        row.RemoteFileId = fileId ?? row.RemoteFileId;
        row.RemoteVersionId = versionId ?? row.RemoteVersionId;
        row.RemoteChecksum = checksum;
        row.Status = "backed_up";
        row.SeenGeneration = generation;
        row.LastBackupAt = _clock.UtcNow;
        row.DeleteAfter = null;
        _database.UpsertIndex(row);
    }

    private async Task<string> FolderAsync(IDriveApi api, string server, string path, CancellationToken cancellationToken)
    {
        var cached = _database.CachedFolder(server, path);
        if (cached != null)
        {
            return cached;
        }

        var id = await api.EnsureFolderAsync(path, cancellationToken);
        _database.CacheFolder(server, path, id);
        return id;
    }

    private bool IsStable(ScannedFile file, ClientSettings settings)
    {
        var minimum = _clock.UtcNow.AddSeconds(-Math.Max(0, settings.StabilitySeconds)).ToUnixTimeMilliseconds();
        if (file.ModifiedUnixMs > minimum)
        {
            return false;
        }

        return FileAccessProbe.CanRead(file.FullPath);
    }

    private static async Task<int> ReadSliceAsync(string path, long offset, byte[] buffer, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, buffer.Length, FileOptions.Asynchronous | FileOptions.SequentialScan);
        stream.Seek(offset, SeekOrigin.Begin);
        var read = 0;
        while (read < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(read), cancellationToken);
            if (count == 0)
            {
                break;
            }

            read += count;
        }

        return read;
    }

    private static async Task PaceAsync(int bytes, long? limit, CancellationToken cancellationToken)
    {
        if (limit is not long perSecond || perSecond <= 0)
        {
            return;
        }

        var delay = TimeSpan.FromSeconds(bytes / (double)perSecond);
        if (delay > TimeSpan.Zero)
        {
            await Task.Delay(delay, cancellationToken);
        }
    }

    private HashSet<string> TakeForce()
    {
        lock (_force)
        {
            var forced = new HashSet<string>(_force, StringComparer.Ordinal);
            _force.Clear();
            if (_backupAll)
            {
                _backupAll = false;
                foreach (var job in _database.ListJobs())
                {
                    forced.Add(job.Id);
                }
            }

            return forced;
        }
    }

    private void RefreshWatchers()
    {
        if (!_watchersDirty)
        {
            return;
        }

        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }

        _watchers.Clear();
        foreach (var job in _database.ListJobs().Where(job => job.Mode == BackupModes.Continuous && !job.Paused && Directory.Exists(job.SourcePath)))
        {
            try
            {
                var watcher = new FileSystemWatcher(job.SourcePath)
                {
                    IncludeSubdirectories = true,
                    EnableRaisingEvents = true,
                    InternalBufferSize = 64 * 1024,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.DirectoryName,
                };
                var id = job.Id;
                FileSystemEventHandler touch = (_, _) => NoteChange(id);
                watcher.Created += touch;
                watcher.Changed += touch;
                watcher.Deleted += touch;
                watcher.Renamed += (_, _) => NoteChange(id);
                watcher.Error += (_, _) => _watchersDirty = true;
                _watchers.Add(watcher);
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
            {
                _database.AddLog("Warning", $"Could not watch {job.SourcePath}");
            }
        }

        _watchersDirty = false;
    }

    private void NoteChange(string jobId)
    {
        lock (_force)
        {
            _force.Add(jobId);
        }
    }

    private void Notify(string title, string body)
    {
        if (!_database.GetSettings().Notifications)
        {
            return;
        }

        _notifier.Notify(title, body);
        _database.EnqueueNotification(title, body);
    }

    private IDriveApi ApiFor(ServerProfile server)
    {
        if (_api != null && _apiUrl == server.Url)
        {
            return _api;
        }

        DropApi();
        _api = _apis(server);
        _apiUrl = server.Url;
        return _api;
    }

    private void DropApi()
    {
        if (_api is IDisposable disposable)
        {
            disposable.Dispose();
        }

        _api = null;
        _apiUrl = null;
    }

    private bool HasAccess(string url) => !string.IsNullOrEmpty(_secrets.Load(SecretKeys.Access(url)));

    private ServerProfile RequireServer() =>
        _database.GetServer() ?? throw new InvalidOperationException("Connect to a server first.");

    private static ServerProfile ProbeProfile(string url, bool allowInsecure)
    {
        var uri = ServerAddress.Normalize(url, allowInsecure);
        return new ServerProfile
        {
            Url = uri.ToString().TrimEnd('/'),
            Name = uri.Host,
            AllowInsecure = allowInsecure,
        };
    }

    private static string Absolute(string server, string path) =>
        path.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? path : server.TrimEnd('/') + "/" + path.TrimStart('/');

    private static string Describe(NetworkSnapshot snapshot)
    {
        if (!snapshot.HasLink)
        {
            return "offline";
        }

        if (snapshot.MeteredKnown && snapshot.Metered)
        {
            return "metered";
        }

        if (snapshot.Wifi && !snapshot.Ethernet)
        {
            return "wifi";
        }

        if (snapshot.Ethernet)
        {
            return "ethernet";
        }

        return "online";
    }

    private static JobSnapshot SnapshotJob(BackupJob job) => new()
    {
        Id = job.Id,
        Name = job.Name,
        SourcePath = job.SourcePath,
        Destination = job.Destination,
        Mode = job.Mode,
        Paused = job.Paused,
        Status = job.Status,
        LastScanAt = job.LastScanAt,
        LastSuccessAt = job.LastSuccessAt,
    };
}
