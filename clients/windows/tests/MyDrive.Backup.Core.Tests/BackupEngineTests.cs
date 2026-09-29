using System.Net;
using Xunit;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MyDrive.Backup.Tests;

public sealed class FilterTests
{
    [Fact]
    public void Globs_match_names_and_paths()
    {
        Assert.True(GlobMatcher.IsMatch("*.tmp", "notes.tmp", "notes.tmp"));
        Assert.False(GlobMatcher.IsMatch("*.tmp", "notes.txt", "notes.txt"));
        Assert.True(GlobMatcher.IsMatch("**/node_modules/**", "src/node_modules/pkg/index.js", "index.js"));
        Assert.True(GlobMatcher.IsMatch("**/.git/**", ".git/config", "config"));
        Assert.True(GlobMatcher.IsMatch("temp/**", "temp/a/b.txt", "b.txt"));
        Assert.True(GlobMatcher.IsMatch("*.log", "dir/app.log", "app.log"));
        Assert.True(GlobMatcher.IsMatch("regex:.*\\.cache$", "a/b.cache", "b.cache"));
        Assert.False(GlobMatcher.IsMatch("regex:(", "a", "a"));
    }

    [Fact]
    public void Filters_skip_system_symlinks_size_and_folders()
    {
        var engine = new FilterEngine();
        var settings = new ClientSettings();
        var job = new BackupJob();
        Assert.False(engine.IncludeFile(Sample("secret.tmp", 10, hidden: true), job, settings));
        Assert.False(engine.IncludeFile(Sample("pagefile.sys", 10, system: true), job, settings));
        Assert.False(engine.IncludeFile(Sample("link.txt", 10, symlink: true), job, settings));
        Assert.False(engine.IncludeFile(Sample("movie.iso", 11L * 1024 * 1024 * 1024), WithMax(job), settings));
        job.MinFileBytes = 100;
        Assert.False(engine.IncludeFile(Sample("tiny.txt", 10), job, settings));
        job.IncludeExtensions = [".jpg"];
        Assert.False(engine.IncludeFile(Sample("note.txt", 200), job, settings));
        Assert.True(engine.IncludeFile(Sample("pic.jpg", 200), job, settings));
        Assert.True(engine.ExcludeDirectory("node_modules", job));
        Assert.False(engine.ExcludeDirectory("Photos", job));
    }

    [Fact]
    public void Scanner_streams_without_excluded_directories_or_symlink_loops()
    {
        var root = Temp();
        File.WriteAllText(Path.Combine(root, "keep.txt"), "keep");
        var nested = Path.Combine(root, "node_modules");
        Directory.CreateDirectory(nested);
        File.WriteAllText(Path.Combine(nested, "skip.js"), "skip");
        var outside = Temp();
        File.WriteAllText(Path.Combine(outside, "secret.txt"), "secret");
        Directory.CreateSymbolicLink(Path.Combine(root, "loop"), root);
        Directory.CreateSymbolicLink(Path.Combine(root, "outside"), outside);
        var job = new BackupJob { SourcePath = root };
        var found = FileScanner.Enumerate(root, job, new ClientSettings(), CancellationToken.None).Select(file => file.RelativePath).ToArray();
        Assert.Contains("keep.txt", found);
        Assert.DoesNotContain("node_modules/skip.js", found);
        Assert.DoesNotContain("outside/secret.txt", found);
        Assert.DoesNotContain(found, path => path.Contains("loop"));
    }

    private static ScannedFile Sample(string name, long size, bool hidden = false, bool system = false, bool symlink = false) =>
        new(name, name, name, size, 0, hidden, system, symlink);

    private static BackupJob WithMax(BackupJob job)
    {
        job.MaxFileBytes = 10L * 1024 * 1024 * 1024;
        return job;
    }

    private static string Temp()
    {
        var path = Path.Combine(Path.GetTempPath(), "mydrive-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}

public sealed class PolicyTests
{
    [Fact]
    public void Retry_classification_and_backoff_follow_the_status()
    {
        Assert.Equal(FailureKind.Refresh, RetryPolicy.Classify(new ApiException(401, "authentication_required")));
        Assert.Equal(FailureKind.Permission, RetryPolicy.Classify(new ApiException(403, "insufficient_scope")));
        Assert.Equal(FailureKind.Missing, RetryPolicy.Classify(new ApiException(404, "not_found")));
        Assert.Equal(FailureKind.RateLimit, RetryPolicy.Classify(new ApiException(429, "too_many_attempts")));
        Assert.Equal(FailureKind.Retry, RetryPolicy.Classify(new ApiException(503, "service_unavailable")));
        Assert.Equal(FailureKind.Network, RetryPolicy.Classify(new IOException("reset")));
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.Delay(0));
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Delay(20));
    }

    [Fact]
    public void Bandwidth_windows_use_the_stricter_limit_and_wrap_midnight()
    {
        var settings = new ClientSettings
        {
            UploadLimitBytesPerSecond = 50 * 1024 * 1024,
            DayLimit = new BandwidthWindow { StartMinutes = 8 * 60, EndMinutes = 18 * 60, BytesPerSecond = 5 * 1024 * 1024 },
            NightLimit = new BandwidthWindow { StartMinutes = 18 * 60, EndMinutes = 8 * 60, BytesPerSecond = null },
        };
        var noon = new DateTimeOffset(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
        var night = new DateTimeOffset(2026, 9, 28, 22, 0, 0, TimeSpan.Zero);
        Assert.Equal(5 * 1024 * 1024, BandwidthPolicy.EffectiveLimit(settings, noon));
        Assert.Null(BandwidthPolicy.EffectiveLimit(settings, night));
    }

    [Fact]
    public void Redactor_removes_tokens_and_the_secret_store_is_not_plaintext()
    {
        var message = """token mdb_abcdefghijklmnopqrstuvwxyz1234567890ABCD password "access_token":"secret-value" """;
        var redacted = SecretRedactor.Redact(message);
        Assert.DoesNotContain("mdb_", redacted);
        Assert.DoesNotContain("secret-value", redacted);
        var directory = Path.Combine(Path.GetTempPath(), "mydrive-secrets", Guid.NewGuid().ToString("N"));
        var store = new AesSecretStore(directory);
        store.Save("https://cloud.example|access", "mdb_abcdefghijklmnopqrstuvwxyz1234567890ABCD");
        var raw = File.ReadAllText(Path.Combine(directory, "secrets.bin"));
        Assert.DoesNotContain("mdb_", raw);
        Assert.Equal("mdb_abcdefghijklmnopqrstuvwxyz1234567890ABCD", store.Load("https://cloud.example|access"));
    }

    [Fact]
    public void Metered_and_wifi_settings_block_uploads()
    {
        var settings = new ClientSettings { BackupOnMetered = false, BackupOnWifi = false, BackupOnEthernet = true };
        Assert.False(NetworkPolicy.AllowsUpload(settings, new NetworkSnapshot(true, true, false, true, true)));
        Assert.False(NetworkPolicy.AllowsUpload(settings, new NetworkSnapshot(true, true, false, false, true)));
        Assert.True(NetworkPolicy.AllowsUpload(settings, new NetworkSnapshot(true, false, true, false, true)));
        Assert.True(NetworkPolicy.AllowsUpload(settings, new NetworkSnapshot(true, false, true, false, false)));
    }
}

public sealed class DatabaseTests
{
    [Fact]
    public void Queue_survives_restart_and_interrupted_claims_return_to_waiting()
    {
        var path = Path.Combine(Path.GetTempPath(), "mydrive-db", Guid.NewGuid().ToString("N"), "backup.db");
        var id = Guid.NewGuid().ToString("N");
        using (var database = new LocalDatabase(path))
        {
            database.SaveJob(new BackupJob { Id = "job", Name = "Docs", BoundServer = "https://cloud.example", SourcePath = "/tmp", Destination = "Backups" });
            database.Enqueue(new UploadItem
            {
                Id = id,
                JobId = "job",
                RelativePath = "a.bin",
                FullPath = "/tmp/a.bin",
                FileSize = 100,
                State = QueueState.Uploading,
                BytesSent = 40,
                RemoteUploadId = "upload-1",
            });
            database.ResetInterrupted();
            var claimed = database.ClaimNext(DateTimeOffset.UtcNow);
            Assert.NotNull(claimed);
            Assert.Equal(40, claimed.BytesSent);
            Assert.Equal("upload-1", claimed.RemoteUploadId);
            Assert.Equal(QueueState.Uploading, claimed.State);
        }

        using var reopened = new LocalDatabase(path);
        var again = Assert.Single(reopened.ListQueue(), item => item.Id == id);
        Assert.Equal(QueueState.Uploading, again.State);
        Assert.Equal(40, again.BytesSent);
    }
}

public sealed class EngineTests
{
    [Fact]
    public async Task Incremental_backup_uploads_only_changed_files()
    {
        using var fixture = await Fixture.Create(fileCount: 40);
        await fixture.Run();
        Assert.Equal(40, fixture.Api.CreateCalls);
        Assert.Equal(40, fixture.Hasher.Calls);

        for (var i = 0; i < 3; i++)
        {
            var path = Path.Combine(fixture.Root, $"file-{i}.txt");
            File.WriteAllText(path, "changed-" + i);
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-10));
        }

        var before = fixture.Hasher.Calls;
        await fixture.Run();
        Assert.Equal(43, fixture.Api.CreateCalls);
        Assert.Equal(before + 3, fixture.Hasher.Calls);
        Assert.Equal(0, fixture.Api.TrashCalls);
    }

    [Fact]
    public async Task Unchanged_content_with_a_new_timestamp_is_not_uploaded()
    {
        using var fixture = await Fixture.Create(fileCount: 2);
        await fixture.Run();
        File.SetLastWriteTimeUtc(Path.Combine(fixture.Root, "file-0.txt"), DateTime.UtcNow.AddMinutes(-2));
        var created = fixture.Api.CreateCalls;
        await fixture.Run();
        Assert.Equal(created, fixture.Api.CreateCalls);
        Assert.Contains(fixture.Database.ListActivity("Skipped"), entry => entry.Reason == "File unchanged");
    }

    [Fact]
    public async Task Empty_and_chunked_files_resume_after_a_dropped_connection()
    {
        using var fixture = await Fixture.Create(fileCount: 0);
        var empty = Path.Combine(fixture.Root, "empty.txt");
        File.WriteAllText(empty, "");
        File.SetLastWriteTimeUtc(empty, DateTime.UtcNow.AddMinutes(-10));
        var large = Path.Combine(fixture.Root, "large.bin");
        var bytes = RandomNumberGenerator.GetBytes(200 * 1024);
        File.WriteAllBytes(large, bytes);
        File.SetLastWriteTimeUtc(large, DateTime.UtcNow.AddMinutes(-10));
        fixture.Api.FailAfterPatches = 1;
        var settings = fixture.Engine.Settings();
        settings.ChunkSizeMb = 0;
        fixture.Engine.SaveSettings(settings);

        await fixture.Run();
        Assert.Equal(2, fixture.Api.CreateCalls);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddMinutes(10);
        fixture.Api.FailAfterPatches = int.MaxValue;
        await fixture.Run();
        Assert.Equal(2, fixture.Api.CreateCalls);
        Assert.Contains(fixture.Api.Patches, patch => patch.Offset == 64 * 1024);
        Assert.Equal(200 * 1024, fixture.Api.Files["folder:Backups/PC/Docs\nlarge.bin"].Size);
    }

    [Fact]
    public async Task Deleting_a_local_file_keeps_the_cloud_copy_unless_the_policy_says_otherwise()
    {
        using var fixture = await Fixture.Create(fileCount: 1);
        await fixture.Run();
        File.Delete(Path.Combine(fixture.Root, "file-0.txt"));
        await fixture.Run();
        Assert.Equal(0, fixture.Api.TrashCalls);
        Assert.Equal("local_missing", fixture.Database.FindIndex(fixture.Job.Id, "file-0.txt")!.Status);

        fixture.Job.DeletionPolicy = DeletionPolicies.Trash;
        fixture.Engine.SaveJob(fixture.Job);
        File.WriteAllText(Path.Combine(fixture.Root, "file-0.txt"), "back");
        File.SetLastWriteTimeUtc(Path.Combine(fixture.Root, "file-0.txt"), DateTime.UtcNow.AddMinutes(-10));
        await fixture.Run();
        File.Delete(Path.Combine(fixture.Root, "file-0.txt"));
        await fixture.Run();
        Assert.Equal(1, fixture.Api.TrashCalls);
    }

    [Fact]
    public async Task Removing_a_job_does_not_delete_remote_files()
    {
        using var fixture = await Fixture.Create(fileCount: 1);
        await fixture.Run();
        fixture.Engine.DeleteJob(fixture.Job.Id);
        Assert.Equal(0, fixture.Api.TrashCalls);
        Assert.Empty(fixture.Engine.Jobs());
        Assert.Single(fixture.Api.Files);
    }

    [Fact]
    public async Task Files_still_being_written_wait_until_they_are_stable()
    {
        using var fixture = await Fixture.Create(fileCount: 0);
        var path = Path.Combine(fixture.Root, "recording.mp4");
        File.WriteAllBytes(path, [1, 2, 3, 4]);
        File.SetLastWriteTimeUtc(path, fixture.Clock.UtcNow.UtcDateTime);
        await fixture.Run();
        Assert.Equal(0, fixture.Api.CreateCalls);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        await fixture.Run();
        Assert.Equal(1, fixture.Api.CreateCalls);
    }

    [Fact]
    public async Task Changing_servers_requires_confirmation_and_pauses_existing_jobs()
    {
        using var fixture = await Fixture.Create(fileCount: 0);
        await Assert.ThrowsAsync<InsecureConnectionException>(() => fixture.Engine.TestServerAsync("http://192.168.1.10:8443", false, CancellationToken.None));
        await Assert.ThrowsAsync<ConfirmationRequiredException>(() => fixture.Engine.SetServerAsync("https://other.example", false, false, CancellationToken.None));
        await fixture.Engine.SetServerAsync("https://other.example", false, true, CancellationToken.None);
        var job = Assert.Single(fixture.Engine.Jobs());
        Assert.True(job.Paused);
        Assert.Equal("paused-server", job.Status);
    }

    [Fact]
    public async Task Incompatible_api_versions_are_reported()
    {
        using var fixture = await Fixture.Create(fileCount: 0);
        fixture.Api.Capabilities.ApiVersion = "9";
        var error = await Assert.ThrowsAsync<ServerCompatibilityException>(() => fixture.Engine.TestServerAsync("https://cloud.example", false, CancellationToken.None));
        Assert.Equal("This server is using an API version that is not supported by this client.", error.Message);
    }

    [Fact]
    public async Task A_thousand_files_are_indexed_without_uploading_them_twice()
    {
        using var fixture = await Fixture.Create(fileCount: 1000);
        var first = await fixture.Run();
        Assert.Equal(1000, first.Uploaded);
        var second = await fixture.Run();
        Assert.Equal(0, second.Uploaded);
        Assert.Equal(1000, fixture.Api.CreateCalls);
        Assert.Equal(1000, fixture.Database.Overview().FilesBackedUp);
    }

    private sealed class Fixture : IDisposable
    {
        public required string Root { get; init; }
        public required LocalDatabase Database { get; init; }
        public required BackupEngine Engine { get; init; }
        public required FakeDrive Api { get; init; }
        public required CountingHasher Hasher { get; init; }
        public required ManualClock Clock { get; init; }
        public required BackupJob Job { get; init; }

        public static Task<Fixture> Create(int fileCount)
        {
            var root = Path.Combine(Path.GetTempPath(), "mydrive-engine", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var state = Path.Combine(Path.GetTempPath(), "mydrive-engine-state", Guid.NewGuid().ToString("N"));
            for (var i = 0; i < fileCount; i++)
            {
                var path = Path.Combine(root, $"file-{i}.txt");
                File.WriteAllText(path, "file-" + i);
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-10));
            }

            var database = new LocalDatabase(Path.Combine(state, "backup.db"));
            var clock = new ManualClock { UtcNow = DateTimeOffset.UtcNow };
            var api = new FakeDrive();
            var hasher = new CountingHasher();
            var engine = new BackupEngine(database, new MemorySecretStore(), clock, hasher: hasher, network: new OnlineNetwork(), apis: _ => api);
            database.SaveServer(new ServerProfile
            {
                Url = "https://cloud.example",
                Name = "cloud.example",
                Connected = true,
                ApiVersion = "1",
                AllowInsecure = false,
            });
            var job = new BackupJob
            {
                Name = "Docs",
                SourcePath = root,
                Destination = "Backups/PC/Docs",
                Mode = BackupModes.Manual,
                BoundServer = "https://cloud.example",
                DeletionPolicy = DeletionPolicies.Keep,
            };
            engine.SaveJob(job);
            return Task.FromResult(new Fixture
            {
                Root = root,
                Database = database,
                Engine = engine,
                Api = api,
                Hasher = hasher,
                Clock = clock,
                Job = job,
            });
        }

        public Task<RunReport> Run()
        {
            Engine.BackupNow(Job.Id);
            return Engine.RunOnceAsync(CancellationToken.None);
        }

        public void Dispose()
        {
            Engine.Dispose();
            Database.Dispose();
        }
    }
}

public sealed class ProtocolTests
{
    [Fact]
    public async Task Client_resumes_from_the_server_offset_and_refreshes_a_rejected_token()
    {
        var secrets = new MemorySecretStore();
        secrets.Save(SecretKeys.Access("https://cloud.example"), "mdb_oldtokenoldtokenoldtokenoldtokenoldtoken");
        secrets.Save(SecretKeys.Refresh("https://cloud.example"), "mdr_refreshtokenrefreshtokenrefreshtokenrefres");
        var calls = new List<string>();
        var handler = new ScriptHandler(request =>
        {
            calls.Add(request.RequestUri!.AbsolutePath);
            if (request.RequestUri.AbsolutePath == "/api/device/refresh")
            {
                return Json(HttpStatusCode.OK, new
                {
                    access_token = "mdb_newtokennewtokennewtokennewtokennewtoken",
                    refresh_token = "mdr_nextrefreshnextrefreshnextrefreshnextre",
                    expires_in = 3600,
                    device_id = "device-1",
                });
            }

            var authorized = request.Headers.Authorization?.Parameter?.Contains("newtoken", StringComparison.Ordinal) == true;
            if (!authorized)
            {
                return Json(HttpStatusCode.Unauthorized, new { error = "authentication_required" });
            }

            if (request.Method == HttpMethod.Patch)
            {
                var response = new HttpResponseMessage(HttpStatusCode.Conflict);
                response.Headers.TryAddWithoutValidation("Upload-Offset", "65536");
                response.Content = new StringContent("""{"error":"offset_mismatch"}""");
                return response;
            }

            return Json(HttpStatusCode.OK, new { quota_bytes = (long?)null, used_bytes = 10L, reserved_bytes = 0L, available_bytes = (long?)null, unlimited = true, by_category = Array.Empty<object>() });
        });

        var api = new RefreshingDriveApi(new Uri("https://cloud.example"), false, secrets, handler);
        var quota = await api.GetStorageAsync(CancellationToken.None);
        Assert.True(quota.Unlimited);
        Assert.Contains("/api/device/refresh", calls);
        Assert.Equal("mdb_newtokennewtokennewtokennewtokennewtoken", secrets.Load(SecretKeys.Access("https://cloud.example")));

        var client = new DriveApiClient(new Uri("https://cloud.example"), () => "mdb_newtokennewtokennewtokennewtokennewtoken", false, handler);
        var error = await Assert.ThrowsAsync<ApiException>(() => client.PatchAsync("upload-1", 0, new byte[8], 8, CancellationToken.None));
        Assert.Equal(409, error.Status);
        Assert.Equal(65536, error.Offset);
    }

    [Fact]
    public async Task Capability_document_enables_only_advertised_features()
    {
        var handler = new ScriptHandler(_ => Json(HttpStatusCode.OK, new
        {
            product = "my-drive",
            apiVersion = "1",
            serverVersion = "0.1.0",
            minClientApi = "1",
            maxClientApi = "1",
            features = new
            {
                chunkedUpload = true,
                resumableUpload = true,
                deduplication = false,
                fileVersions = true,
                deviceAuthorization = true,
                contentHash = "sha256",
            },
            upload = new { protocol = "tus-offset", maxChunkBytes = 67108864 },
        }));
        var client = new DriveApiClient(new Uri("https://cloud.example"), () => null, false, handler);
        var capabilities = await client.GetCapabilitiesAsync(CancellationToken.None);
        Assert.False(capabilities.Deduplication);
        Assert.True(capabilities.ResumableUpload);
        Assert.Equal(67108864, capabilities.MaxChunkBytes);
        ServerAddress.EnsureCompatible(capabilities);
    }

    [Fact]
    public async Task Control_requests_require_confirmation_for_destructive_actions()
    {
        var root = Path.Combine(Path.GetTempPath(), "mydrive-control", Guid.NewGuid().ToString("N"));
        var database = new LocalDatabase(Path.Combine(root, "backup.db"));
        var engine = new BackupEngine(database, new MemorySecretStore(), network: new OnlineNetwork(), apis: _ => new FakeDrive());
        engine.SaveJob(new BackupJob { Id = "job", Name = "Docs", SourcePath = root, Destination = "Backups", BoundServer = "https://cloud.example" });
        var control = new ControlServer(engine, "MyDrive.Backup.Tests." + Guid.NewGuid().ToString("N"));
        var denied = await control.HandleAsync(JsonSerializer.SerializeToElement(new { method = "jobs.delete", id = "job" }), CancellationToken.None);
        Assert.False(denied.GetProperty("ok").GetBoolean());
        Assert.Equal("confirmation_required", denied.GetProperty("error").GetString());
        var removed = await control.HandleAsync(JsonSerializer.SerializeToElement(new { method = "jobs.delete", id = "job", confirm = true }), CancellationToken.None);
        Assert.True(removed.GetProperty("ok").GetBoolean());
        Assert.Empty(engine.Jobs());
        engine.Dispose();
        database.Dispose();
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body)
    {
        var response = new HttpResponseMessage(status);
        response.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return response;
    }

    private sealed class ScriptHandler(Func<HttpRequestMessage, HttpResponseMessage> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(handle(request));
    }
}

internal sealed class OnlineNetwork : INetworkMonitor
{
    public NetworkSnapshot Snapshot() => new(true, false, true, false, false);
}

internal sealed class CountingHasher : IContentHasher
{
    private readonly Sha256Hasher _inner = new();

    public int Calls;

    public async Task<string> HashAsync(string path, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref Calls);
        return await _inner.HashAsync(path, cancellationToken);
    }
}

internal sealed class FakeDrive : IDriveApi
{
    public ServerCapabilities Capabilities { get; } = new()
    {
        Product = "my-drive",
        ApiVersion = "1",
        ServerVersion = "0.1.0",
        MinClientApi = "1",
        MaxClientApi = "1",
        ChunkedUpload = true,
        ResumableUpload = true,
        Deduplication = true,
        FileVersions = true,
        DeviceAuthorization = true,
        ContentHash = "sha256",
        MaxChunkBytes = 64 * 1024 * 1024,
    };

    public int CreateCalls;
    public int TrashCalls;
    public int FailAfterPatches = int.MaxValue;
    public List<(long Offset, int Count)> Patches { get; } = [];
    public Dictionary<string, StoredFile> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly HashSet<string> _objects = new(StringComparer.OrdinalIgnoreCase);
    private int _patches;

    public Task<ServerCapabilities> GetCapabilitiesAsync(CancellationToken cancellationToken) => Task.FromResult(Capabilities);

    public Task<DeviceCodeStart> StartDeviceCodeAsync(string deviceName, CancellationToken cancellationToken) =>
        Task.FromResult(new DeviceCodeStart { DeviceCode = "device-code-value-1234567890", UserCode = "ABCD-EFGH", VerificationUri = "/device/authorize", VerificationUriComplete = "/device/authorize?user_code=ABCD-EFGH", ExpiresIn = 600, Interval = 5 });

    public Task<DevicePoll> PollDeviceCodeAsync(string deviceCode, CancellationToken cancellationToken) =>
        Task.FromResult(new DevicePoll { Pending = true, IntervalSeconds = 5 });

    public Task<TokenSet> RefreshAsync(string refreshToken, CancellationToken cancellationToken) => throw new NotSupportedException();

    public Task<AccountProfile> GetAccountAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new AccountProfile { Id = "user", Email = "user@example.com", Role = "owner" });

    public Task<StorageQuota> GetStorageAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new StorageQuota { Unlimited = true, UsedBytes = Files.Values.Sum(file => file.Size) });

    public Task HeartbeatAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task LogoutAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<string> EnsureFolderAsync(string path, CancellationToken cancellationToken) => Task.FromResult("folder:" + path);

    public Task<ContentCheck> CheckAsync(string? parentId, string name, long size, string hash, CancellationToken cancellationToken)
    {
        var key = Key(parentId, name);
        if (Files.TryGetValue(key, out var existing) && existing.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase) && existing.Size == size)
        {
            return Task.FromResult(new ContentCheck { Action = "skip", FileId = existing.Id, VersionId = existing.Version, RemoteChecksum = existing.Hash, Reusable = true });
        }

        if (_objects.Contains(hash))
        {
            return Task.FromResult(new ContentCheck { Action = "link", FileId = existing?.Id, VersionId = existing?.Version, Reusable = true });
        }

        return Task.FromResult(new ContentCheck { Action = "upload", FileId = existing?.Id, VersionId = existing?.Version, Reusable = false });
    }

    public Task<LinkResult> LinkAsync(string? parentId, string name, long size, string hash, DateTimeOffset? modified, CancellationToken cancellationToken)
    {
        if (!_objects.Contains(hash))
        {
            throw new ApiException(404, "content_not_found");
        }

        var stored = Remember(parentId, name, size, hash);
        return Task.FromResult(new LinkResult { FileId = stored.Id, VersionId = stored.Version, Checksum = hash, Unchanged = false });
    }

    public Task<UploadSessionInfo> CreateUploadAsync(string filename, long size, string? parentId, string? fileId, DateTimeOffset? modified, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid().ToString("N");
        _sessions[id] = new Session(parentId, filename, size, fileId);
        Interlocked.Increment(ref CreateCalls);
        return Task.FromResult(new UploadSessionInfo { Id = id, Offset = 0, Length = size });
    }

    public Task<long> HeadOffsetAsync(string uploadId, CancellationToken cancellationToken) =>
        Task.FromResult(_sessions[uploadId].Offset);

    public Task<long> PatchAsync(string uploadId, long offset, byte[] data, int count, CancellationToken cancellationToken)
    {
        var seen = Interlocked.Increment(ref _patches);
        if (seen > FailAfterPatches)
        {
            throw new IOException("Connection lost");
        }

        var session = _sessions[uploadId];
        if (session.Offset != offset)
        {
            throw new ApiException(409, "offset_mismatch", offset: session.Offset);
        }

        session.Offset += count;
        Patches.Add((offset, count));
        return Task.FromResult(session.Offset);
    }

    public Task<FinalizeResult> FinalizeAsync(string uploadId, string sha256, CancellationToken cancellationToken)
    {
        var session = _sessions[uploadId];
        if (session.Offset != session.Size)
        {
            throw new ApiException(409, "conflict");
        }

        _objects.Add(sha256);
        var stored = Remember(session.ParentId, session.Name, session.Size, sha256);
        return Task.FromResult(new FinalizeResult { FileId = stored.Id, VersionId = stored.Version, Checksum = sha256 });
    }

    public Task TrashAsync(string fileId, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref TrashCalls);
        var match = Files.FirstOrDefault(pair => pair.Value.Id == fileId);
        if (!string.IsNullOrEmpty(match.Key))
        {
            Files.Remove(match.Key);
        }

        return Task.CompletedTask;
    }

    public Task RenameAsync(string fileId, string name, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task MoveAsync(string fileId, string parentId, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<IReadOnlyList<RemoteVersion>> VersionsAsync(string fileId, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<RemoteVersion>>([]);

    private StoredFile Remember(string? parentId, string name, long size, string hash)
    {
        var key = Key(parentId, name);
        if (!Files.TryGetValue(key, out var existing))
        {
            existing = new StoredFile(Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"), hash, size);
        }
        else
        {
            existing = existing with { Hash = hash, Size = size, Version = Guid.NewGuid().ToString("N") };
        }

        Files[key] = existing;
        return existing;
    }

    private static string Key(string? parentId, string name) => (parentId ?? "") + "\n" + name;

    private sealed class Session(string? parentId, string name, long size, string? fileId)
    {
        public string? ParentId { get; } = parentId;
        public string Name { get; } = name;
        public long Size { get; } = size;
        public string? FileId { get; } = fileId;
        public long Offset { get; set; }
    }
}

internal sealed record StoredFile(string Id, string Version, string Hash, long Size);
