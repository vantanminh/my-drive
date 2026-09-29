using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;

namespace MyDrive.Backup.Tests;

public sealed class ClientUpdateTests
{
    [Fact]
    public void Versions_compare_numerically_and_match_the_published_client()
    {
        Assert.True(ClientVersion.TryParse("1.10.0", out var newer));
        Assert.True(ClientVersion.TryParse("1.9.0", out var older));
        Assert.True(newer.CompareTo(older) > 0);
        Assert.False(ClientVersion.TryParse("1.2.0-beta", out _));
        Assert.Equal("1.1.0", ClientInfo.Version);
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "Directory.Build.props")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);
        var props = File.ReadAllText(Path.Combine(directory.FullName, "Directory.Build.props"));
        Assert.Contains("<Version>" + ClientInfo.Version + "</Version>", props, StringComparison.Ordinal);
        Assert.Contains("<AssemblyVersion>" + ClientInfo.Version + ".0</AssemblyVersion>", props, StringComparison.Ordinal);
    }

    [Fact]
    public void The_newest_stable_client_release_is_selected()
    {
        using var document = JsonDocument.Parse(
            """
            [
              {"tag_name":"windows-backup","draft":false,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-backup/MyDriveBackup-Setup.exe","size":1}]},
              {"tag_name":"windows-client-v1.0.0","draft":false,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-client-v1.0.0/MyDriveBackup-Setup.exe","size":2}]},
              {"tag_name":"windows-client-v1.2.0","draft":false,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-client-v1.2.0/MyDriveBackup-Setup.exe","size":3}]},
              {"tag_name":"windows-client-v9.0.0","draft":true,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-client-v9.0.0/MyDriveBackup-Setup.exe","size":4}]},
              {"tag_name":"windows-client-v1.3.0","draft":false,"prerelease":true,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-client-v1.3.0/MyDriveBackup-Setup.exe","size":5}]},
              {"tag_name":"windows-client-v1.4.0","draft":false,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"http://evil.example/setup.exe","size":6}]}
            ]
            """);
        var selected = UpdateCatalog.Select(document.RootElement, ClientInfo.Version);
        Assert.NotNull(selected);
        Assert.Equal("1.2.0", selected.Version);
        Assert.Equal(3, selected.Size);
        Assert.False(UpdateCatalog.IsTrustedDownload("http://github.com/vantanminh/my-drive/setup.exe"));
        Assert.True(UpdateCatalog.IsTrustedDownload(selected.DownloadUrl));
        Assert.Null(UpdateCatalog.Select(document.RootElement, "1.2.0"));
    }

    [Fact]
    public async Task Check_reports_a_newer_version_without_installing_it()
    {
        using var harness = UpdateHarness.Create(autoInstall: false);
        var snapshot = await harness.Service.CheckAsync(false, CancellationToken.None);
        Assert.Equal("available", snapshot.State);
        Assert.Equal("1.2.0", snapshot.AvailableVersion);
        Assert.Equal(ClientInfo.Version, snapshot.ClientVersion);
        Assert.Empty(harness.Launcher.Paths);
        Assert.Equal(1, harness.Hits);

        harness.Clock.UtcNow = harness.Clock.UtcNow.AddMinutes(1);
        harness.Service.MaybeCheck(new ClientSettings { CheckForUpdates = true, AutoInstallUpdates = false }, CancellationToken.None);
        await Task.Delay(50);
        Assert.Equal(1, harness.Hits);
    }

    [Fact]
    public async Task Automatic_install_downloads_the_published_installer()
    {
        using var harness = UpdateHarness.Create(autoInstall: true);
        var snapshot = await harness.Service.CheckAsync(true, CancellationToken.None);
        Assert.Equal("installing", snapshot.State);
        Assert.Equal("1.2.0", snapshot.AvailableVersion);
        var path = Assert.Single(harness.Launcher.Paths);
        Assert.True(File.Exists(path));
        Assert.Equal(Encoding.ASCII.GetByteCount("setup-bytes"), new FileInfo(path).Length);
        Assert.True(harness.Exited);

        harness.Service.MaybeCheck(new ClientSettings { CheckForUpdates = false, AutoInstallUpdates = true }, CancellationToken.None);
        await Task.Delay(50);
        Assert.Equal(2, harness.Hits);
    }

    [Fact]
    public async Task The_control_api_checks_for_an_update()
    {
        using var harness = UpdateHarness.Create(autoInstall: false);
        var engine = new BackupEngine(
            harness.Database,
            new MemorySecretStore(),
            harness.Clock,
            network: new OnlineNetwork(),
            apis: _ => new FakeDrive(),
            updates: harness.Service);
        engine.SaveSettings(new ClientSettings { CheckForUpdates = true, AutoInstallUpdates = false });
        var control = new ControlServer(engine, "MyDrive.Backup.Tests." + Guid.NewGuid().ToString("N"));
        var response = await control.HandleAsync(JsonSerializer.SerializeToElement(new { method = "update.check" }), CancellationToken.None);
        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal("1.2.0", response.GetProperty("result").GetProperty("availableVersion").GetString());
        Assert.Equal(ClientInfo.Version, engine.Status().ClientVersion);
        engine.Dispose();
    }

    private sealed class UpdateHarness : IDisposable
    {
        public required LocalDatabase Database { get; init; }
        public required ManualClock Clock { get; init; }
        public required RecordingLauncher Launcher { get; init; }
        public ClientUpdateService Service { get; set; } = null!;
        public int Hits;
        public bool Exited;

        public static UpdateHarness Create(bool autoInstall)
        {
            _ = autoInstall;
            var root = Path.Combine(Path.GetTempPath(), "mydrive-update", Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(root);
            var database = new LocalDatabase(Path.Combine(root, "backup.db"));
            var clock = new ManualClock { UtcNow = DateTimeOffset.Parse("2026-09-29T12:00:00Z") };
            var launcher = new RecordingLauncher();
            var harness = new UpdateHarness
            {
                Database = database,
                Clock = clock,
                Launcher = launcher,
            };
            var handler = new UpdateHandler(harness);
            harness.Service = new ClientUpdateService(
                database,
                clock,
                () => new HttpClient(handler, disposeHandler: false),
                launcher,
                "vantanminh/my-drive",
                Path.Combine(root, "downloads"),
                TimeSpan.Zero)
            {
                ExitProcess = () => harness.Exited = true,
            };
            return harness;
        }

        public void Dispose() => Database.Dispose();

        public sealed class RecordingLauncher : IUpdateLauncher
        {
            public List<string> Paths { get; } = [];

            public void LaunchInstaller(string installerPath) => Paths.Add(installerPath);
        }

        private sealed class UpdateHandler(UpdateHarness harness) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref harness.Hits);
                var path = request.RequestUri?.AbsolutePath ?? "";
                if (path.EndsWith("/" + ClientInfo.InstallerFileName, StringComparison.OrdinalIgnoreCase))
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(Encoding.ASCII.GetBytes("setup-bytes")),
                    });
                }

                if (path.Contains("/releases", StringComparison.Ordinal))
                {
                    var body = """
                        [{"tag_name":"windows-client-v1.2.0","draft":false,"prerelease":false,"assets":[{"name":"MyDriveBackup-Setup.exe","browser_download_url":"https://github.com/vantanminh/my-drive/releases/download/windows-client-v1.2.0/MyDriveBackup-Setup.exe","size":11}]}]
                        """;
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(body, Encoding.UTF8, "application/json"),
                    });
                }

                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent(Encoding.ASCII.GetBytes("setup-bytes")),
                });
            }
        }
    }
}
