namespace MyDrive.Backup;

public sealed class ServerProfile
{
    public string Url { get; set; } = "";
    public string Name { get; set; } = "";
    public string? ApiVersion { get; set; }
    public string? ServerVersion { get; set; }
    public string? AccountEmail { get; set; }
    public string? DeviceId { get; set; }
    public bool AllowInsecure { get; set; }
    public bool Connected { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class ClientSettings
{
    public int ConcurrentUploads { get; set; } = 3;
    public int HashConcurrency { get; set; } = 2;
    public int ChunkSizeMb { get; set; } = 8;
    public long? UploadLimitBytesPerSecond { get; set; }
    public BandwidthWindow? DayLimit { get; set; }
    public BandwidthWindow? NightLimit { get; set; }
    public bool BackupOnWifi { get; set; } = true;
    public bool BackupOnEthernet { get; set; } = true;
    public bool BackupOnMetered { get; set; }
    public bool StartWithWindows { get; set; } = true;
    public bool RunInBackground { get; set; } = true;
    public bool Notifications { get; set; } = true;
    public string Language { get; set; } = "auto";
    public string Theme { get; set; } = "system";
    public bool CheckForUpdates { get; set; } = true;
    public bool AutoInstallUpdates { get; set; } = true;
    public int RetryLimit { get; set; } = 8;
    public int StabilitySeconds { get; set; } = 5;
    public bool BackupHiddenFiles { get; set; }
    public bool BackupSystemFiles { get; set; }
    public bool FollowSymlinks { get; set; }
    public string DefaultDestination { get; set; } = "Backups";
    public string DeletionPolicy { get; set; } = DeletionPolicies.Keep;
    public int DeletionDelayDays { get; set; } = 30;
}

public sealed class BandwidthWindow
{
    public int StartMinutes { get; set; }
    public int EndMinutes { get; set; }
    public long? BytesPerSecond { get; set; }
}

public static class DeletionPolicies
{
    public const string Keep = "keep";
    public const string Trash = "trash";
    public const string Delay = "delay";
}

public static class BackupModes
{
    public const string Continuous = "continuous";
    public const string Scheduled = "scheduled";
    public const string Manual = "manual";
}

public static class ScheduleKinds
{
    public const string Minutes = "minutes";
    public const string Hourly = "hourly";
    public const string Daily = "daily";
    public const string Weekly = "weekly";
}

public static class QueueState
{
    public const string Waiting = "Waiting";
    public const string Hashing = "Hashing";
    public const string CheckingServer = "CheckingServer";
    public const string Uploading = "Uploading";
    public const string Paused = "Paused";
    public const string Completed = "Completed";
    public const string Skipped = "Skipped";
    public const string Failed = "Failed";
    public const string Retrying = "Retrying";
}

public sealed class BackupJob
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string SourcePath { get; set; } = "";
    public string Destination { get; set; } = "";
    public string Mode { get; set; } = BackupModes.Continuous;
    public string ScheduleKind { get; set; } = ScheduleKinds.Daily;
    public int ScheduleEveryMinutes { get; set; } = 60;
    public int ScheduleHour { get; set; } = 2;
    public int ScheduleMinute { get; set; }
    public int ScheduleWeekday { get; set; } = 1;
    public List<string> IncludeExtensions { get; set; } = [];
    public List<string> ExcludeExtensions { get; set; } = [".tmp", ".log", ".cache"];
    public List<string> ExcludeFolders { get; set; } = ["node_modules", ".git", "target", "dist", ".cache", "Temp"];
    public List<string> ExcludePatterns { get; set; } = ["*.tmp", "*.log", "**/.git/**", "**/node_modules/**"];
    public long? MaxFileBytes { get; set; }
    public long? MinFileBytes { get; set; }
    public bool? BackupHidden { get; set; }
    public bool? BackupSystem { get; set; }
    public bool? FollowSymlinks { get; set; }
    public string DeletionPolicy { get; set; } = DeletionPolicies.Keep;
    public int DeletionDelayDays { get; set; } = 30;
    public bool Paused { get; set; }
    public string BoundServer { get; set; } = "";
    public long ScanGeneration { get; set; }
    public DateTimeOffset? LastScanAt { get; set; }
    public DateTimeOffset? LastSuccessAt { get; set; }
    public string Status { get; set; } = "idle";
}

public sealed class FileIndexRow
{
    public string JobId { get; set; } = "";
    public string RelativePath { get; set; } = "";
    public long FileSize { get; set; }
    public long ModifiedUnixMs { get; set; }
    public string? ContentHash { get; set; }
    public string? RemoteFileId { get; set; }
    public string? RemoteVersionId { get; set; }
    public string? RemoteChecksum { get; set; }
    public DateTimeOffset? LastBackupAt { get; set; }
    public string Status { get; set; } = "pending";
    public long SeenGeneration { get; set; }
    public DateTimeOffset? DeleteAfter { get; set; }
}

public sealed class UploadItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string JobId { get; set; } = "";
    public string RelativePath { get; set; } = "";
    public string FullPath { get; set; } = "";
    public long FileSize { get; set; }
    public long ModifiedUnixMs { get; set; }
    public string State { get; set; } = QueueState.Waiting;
    public long BytesSent { get; set; }
    public string? RemoteUploadId { get; set; }
    public string? RemoteParentId { get; set; }
    public string? ExistingFileId { get; set; }
    public string? ContentHash { get; set; }
    public string? Error { get; set; }
    public int RetryCount { get; set; }
    public DateTimeOffset? NextRetryAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ActivityEntry
{
    public long Id { get; set; }
    public DateTimeOffset At { get; set; }
    public string Kind { get; set; } = "";
    public string Path { get; set; } = "";
    public string? Reason { get; set; }
    public string? JobId { get; set; }
}

public sealed class LogEntry
{
    public long Id { get; set; }
    public DateTimeOffset At { get; set; }
    public string Level { get; set; } = "Info";
    public string Message { get; set; } = "";
}

public sealed record ScannedFile(
    string FullPath,
    string RelativePath,
    string Name,
    long Size,
    long ModifiedUnixMs,
    bool Hidden,
    bool System,
    bool Symlink);

public sealed record NetworkSnapshot(bool HasLink, bool Wifi, bool Ethernet, bool Metered, bool MeteredKnown);

public sealed class EngineSnapshot
{
    public bool Running { get; set; }
    public bool Paused { get; set; }
    public string? PauseReason { get; set; }
    public string NetworkStatus { get; set; } = "unknown";
    public int ActiveUploads { get; set; }
    public int QueueSize { get; set; }
    public int Failed { get; set; }
    public int Retrying { get; set; }
    public int Workers { get; set; }
    public long SessionUploadedBytes { get; set; }
    public long RemainingBytes { get; set; }
    public double BytesPerSecond { get; set; }
    public IReadOnlyList<double> SpeedHistory { get; set; } = [];
    public IReadOnlyDictionary<string, double> TransferSpeeds { get; set; } = new Dictionary<string, double>();
    public ServerProfile? Server { get; set; }
    public StorageQuota? Storage { get; set; }
    public BackupOverview Overview { get; set; } = new();
    public IReadOnlyList<JobSnapshot> Jobs { get; set; } = [];
    public IReadOnlyList<UploadItem> Transfers { get; set; } = [];
    public string? AuthState { get; set; }
    public string? AuthDetail { get; set; }
    public string? AuthUserCode { get; set; }
    public string ClientVersion { get; set; } = ClientInfo.Version;
    public string? AvailableVersion { get; set; }
    public string UpdateState { get; set; } = "idle";
    public string? UpdateDetail { get; set; }
}

public sealed class JobSnapshot
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string SourcePath { get; set; } = "";
    public string Destination { get; set; } = "";
    public string Mode { get; set; } = "";
    public bool Paused { get; set; }
    public string Status { get; set; } = "";
    public DateTimeOffset? LastScanAt { get; set; }
    public DateTimeOffset? LastSuccessAt { get; set; }
}

public sealed class BackupOverview
{
    public int ProtectedFolders { get; set; }
    public long FilesBackedUp { get; set; }
    public long BackupBytes { get; set; }
    public DateTimeOffset? LastBackupAt { get; set; }
}

public sealed class ServerCapabilities
{
    public string Product { get; set; } = "";
    public string ApiVersion { get; set; } = "";
    public string ServerVersion { get; set; } = "";
    public string MinClientApi { get; set; } = "";
    public string MaxClientApi { get; set; } = "";
    public bool ChunkedUpload { get; set; }
    public bool ResumableUpload { get; set; }
    public bool Deduplication { get; set; }
    public bool FileVersions { get; set; }
    public bool DeviceAuthorization { get; set; }
    public string ContentHash { get; set; } = "";
    public long MaxChunkBytes { get; set; } = 8 * 1024 * 1024;
}

public sealed class StorageQuota
{
    public long? QuotaBytes { get; set; }
    public long UsedBytes { get; set; }
    public long ReservedBytes { get; set; }
    public long? AvailableBytes { get; set; }
    public double? PercentUsed { get; set; }
    public bool Unlimited { get; set; }
    public long FileCount { get; set; }
}

public sealed class AccountProfile
{
    public string Id { get; set; } = "";
    public string Email { get; set; } = "";
    public string Role { get; set; } = "";
}

public sealed class ContentCheck
{
    public string Action { get; set; } = "upload";
    public string? FileId { get; set; }
    public string? VersionId { get; set; }
    public string? RemoteChecksum { get; set; }
    public bool Reusable { get; set; }
}

public sealed class LinkResult
{
    public string FileId { get; set; } = "";
    public string VersionId { get; set; } = "";
    public string Checksum { get; set; } = "";
    public bool Unchanged { get; set; }
}

public sealed class UploadSessionInfo
{
    public string Id { get; set; } = "";
    public long Offset { get; set; }
    public long Length { get; set; }
}

public sealed class FinalizeResult
{
    public string FileId { get; set; } = "";
    public string? VersionId { get; set; }
    public string? Checksum { get; set; }
}

public sealed class RemoteVersion
{
    public string Id { get; set; } = "";
    public long SizeBytes { get; set; }
    public string? Checksum { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public bool Current { get; set; }
}

public sealed class TokenSet
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public int ExpiresIn { get; set; }
    public string DeviceId { get; set; } = "";
}

public sealed class DeviceCodeStart
{
    public string DeviceCode { get; set; } = "";
    public string UserCode { get; set; } = "";
    public string VerificationUri { get; set; } = "";
    public string VerificationUriComplete { get; set; } = "";
    public int ExpiresIn { get; set; }
    public int Interval { get; set; }
}

public sealed class DevicePoll
{
    public bool Authorized { get; set; }
    public bool Pending { get; set; }
    public bool SlowDown { get; set; }
    public bool Denied { get; set; }
    public bool Expired { get; set; }
    public int IntervalSeconds { get; set; } = 5;
    public string? Error { get; set; }
    public TokenSet? Tokens { get; set; }
}

public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

public interface INotifier
{
    void Notify(string title, string body);
}

public sealed class NullNotifier : INotifier
{
    public void Notify(string title, string body)
    {
    }
}
