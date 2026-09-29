using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;

namespace MyDrive.Backup;

public readonly record struct ClientVersion(int Major, int Minor, int Patch) : IComparable<ClientVersion>
{
    public int CompareTo(ClientVersion other)
    {
        var major = Major.CompareTo(other.Major);
        if (major != 0)
        {
            return major;
        }

        var minor = Minor.CompareTo(other.Minor);
        return minor != 0 ? minor : Patch.CompareTo(other.Patch);
    }

    public override string ToString() => $"{Major}.{Minor}.{Patch}";

    public static bool TryParse(string? text, out ClientVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var parts = text.Trim().Split('.');
        if (parts.Length is < 2 or > 3)
        {
            return false;
        }

        if (!int.TryParse(parts[0], out var major) || major < 0)
        {
            return false;
        }

        if (!int.TryParse(parts[1], out var minor) || minor < 0)
        {
            return false;
        }

        var patch = 0;
        if (parts.Length == 3 && (!int.TryParse(parts[2], out patch) || patch < 0))
        {
            return false;
        }

        version = new ClientVersion(major, minor, patch);
        return true;
    }
}

public sealed record ClientRelease(string Version, string DownloadUrl, long Size);

public sealed record UpdateSnapshot(string ClientVersion, string? AvailableVersion, string State, string? Detail);

public static class UpdateCatalog
{
    public static bool IsTrustedDownload(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("objects.githubusercontent.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("release-assets.githubusercontent.com", StringComparison.OrdinalIgnoreCase);
    }

    public static ClientRelease? Select(JsonElement releases, string currentVersion)
    {
        if (!ClientVersion.TryParse(currentVersion, out var current))
        {
            return null;
        }

        return Select(releases, current);
    }

    public static ClientRelease? Select(JsonElement releases, ClientVersion current)
    {
        if (releases.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        ClientRelease? best = null;
        var bestVersion = current;
        foreach (var release in releases.EnumerateArray())
        {
            if (Flag(release, "draft") || Flag(release, "prerelease"))
            {
                continue;
            }

            var tag = Text(release, "tag_name");
            if (!tag.StartsWith(ClientInfo.ReleaseTagPrefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!ClientVersion.TryParse(tag[ClientInfo.ReleaseTagPrefix.Length..], out var version) || version.CompareTo(bestVersion) <= 0)
            {
                continue;
            }

            if (!release.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var asset in assets.EnumerateArray())
            {
                if (!string.Equals(Text(asset, "name"), ClientInfo.InstallerFileName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var url = Text(asset, "browser_download_url");
                if (!IsTrustedDownload(url))
                {
                    continue;
                }

                var size = asset.TryGetProperty("size", out var sizeValue) && sizeValue.TryGetInt64(out var bytes) ? bytes : 0;
                best = new ClientRelease(version.ToString(), url, size);
                bestVersion = version;
                break;
            }
        }

        return best;
    }

    public static async Task<ClientRelease?> FindNewerAsync(HttpClient http, string repository, string currentVersion, CancellationToken cancellationToken)
    {
        if (!ClientVersion.TryParse(currentVersion, out var current))
        {
            throw new InvalidOperationException("The client version is not valid.");
        }

        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "https://api.github.com/repos/" + repository.Trim('/') + "/releases?per_page=30");
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        return Select(document.RootElement, current);
    }

    private static bool Flag(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}

public interface IUpdateLauncher
{
    void LaunchInstaller(string installerPath);
}

public sealed class WindowsUpdateLauncher : IUpdateLauncher
{
    public void LaunchInstaller(string installerPath)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("The backup client installer runs on Windows.");
        }

        if (!File.Exists(installerPath))
        {
            throw new FileNotFoundException("The update installer was not downloaded.", installerPath);
        }

        var directory = Path.GetDirectoryName(installerPath) ?? Path.GetTempPath();
        var script = Path.Combine(directory, "install-update.cmd");
        File.WriteAllText(
            script,
            "@echo off\r\nping 127.0.0.1 -n 4 >nul\r\n\"" + installerPath + "\" " + ClientUpdateService.InstallerArguments + "\r\n");
        var started = Process.Start(new ProcessStartInfo
        {
            FileName = script,
            CreateNoWindow = true,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
        if (started == null)
        {
            throw new InvalidOperationException("The update installer did not start.");
        }
    }
}

public sealed class ClientUpdateService
{
    public const string InstallerArguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS";
    public static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);
    public static readonly TimeSpan FailureInterval = TimeSpan.FromMinutes(15);
    private const string NextCheckKey = "update-next-check";

    private readonly LocalDatabase _database;
    private readonly IClock _clock;
    private readonly Func<HttpClient> _http;
    private readonly IUpdateLauncher _launcher;
    private readonly string _repository;
    private readonly string _directory;
    private readonly TimeSpan _exitDelay;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _state = new();
    private UpdateSnapshot _snapshot = new(ClientInfo.Version, null, "idle", null);
    private ClientRelease? _offer;
    private int _checking;

    public ClientUpdateService(
        LocalDatabase database,
        IClock clock,
        Func<HttpClient>? httpFactory = null,
        IUpdateLauncher? launcher = null,
        string? repository = null,
        string? downloadDirectory = null,
        TimeSpan? exitDelay = null)
    {
        _database = database;
        _clock = clock;
        _http = httpFactory ?? CreateClient;
        _launcher = launcher ?? new WindowsUpdateLauncher();
        _repository = string.IsNullOrWhiteSpace(repository) ? ClientInfo.UpdateRepository : repository.Trim();
        _directory = string.IsNullOrWhiteSpace(downloadDirectory)
            ? Path.Combine(ClientInfo.DataDirectory, "updates")
            : downloadDirectory;
        _exitDelay = exitDelay ?? TimeSpan.FromMilliseconds(1200);
    }

    public Action? ExitProcess { get; set; }

    public UpdateSnapshot Snapshot
    {
        get
        {
            lock (_state)
            {
                return _snapshot;
            }
        }
    }

    public void MaybeCheck(ClientSettings settings, CancellationToken cancellationToken)
    {
        if (!settings.CheckForUpdates || !Due())
        {
            return;
        }

        if (Interlocked.CompareExchange(ref _checking, 1, 0) != 0)
        {
            return;
        }

        _ = RunCheckedAsync(settings.AutoInstallUpdates, cancellationToken);
    }

    public async Task<UpdateSnapshot> CheckAsync(bool autoInstall, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await CheckCoreAsync(autoInstall, cancellationToken).ConfigureAwait(false);
            return Snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<UpdateSnapshot> InstallAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InstallCoreAsync(null, cancellationToken).ConfigureAwait(false);
            return Snapshot;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or InvalidOperationException or PlatformNotSupportedException)
        {
            Publish("failed", CurrentOffer()?.Version, ex.Message);
            _database.AddLog("Warning", "Update install failed: " + ex.Message);
            return Snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task RunCheckedAsync(bool autoInstall, CancellationToken cancellationToken)
    {
        try
        {
            await CheckAsync(autoInstall, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            Interlocked.Exchange(ref _checking, 0);
        }
    }

    private bool Due()
    {
        var raw = _database.GetMeta(NextCheckKey);
        return !DateTimeOffset.TryParse(raw, out var at) || _clock.UtcNow >= at;
    }

    private void Schedule(TimeSpan delay) =>
        _database.SetMeta(NextCheckKey, (_clock.UtcNow + delay).ToString("O"));

    private async Task CheckCoreAsync(bool autoInstall, CancellationToken cancellationToken)
    {
        Publish("checking", CurrentOffer()?.Version, null);
        using var http = _http();
        try
        {
            var release = await UpdateCatalog.FindNewerAsync(http, _repository, ClientInfo.Version, cancellationToken).ConfigureAwait(false);
            Schedule(CheckInterval);
            if (release == null)
            {
                lock (_state)
                {
                    _offer = null;
                }

                Publish("current", null, null);
                return;
            }

            lock (_state)
            {
                _offer = release;
            }

            Publish("available", release.Version, null);
            _database.AddLog("Info", "Backup client " + release.Version + " is available.");
            if (autoInstall)
            {
                await InstallCoreAsync(http, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or JsonException or InvalidOperationException or PlatformNotSupportedException)
        {
            Schedule(FailureInterval);
            Publish("failed", CurrentOffer()?.Version, ex.Message);
            _database.AddLog("Warning", "Update check failed: " + ex.Message);
        }
    }

    private async Task InstallCoreAsync(HttpClient? http, CancellationToken cancellationToken)
    {
        var offer = CurrentOffer() ?? throw new InvalidOperationException("No update is available.");
        if (!UpdateCatalog.IsTrustedDownload(offer.DownloadUrl))
        {
            throw new InvalidOperationException("The update download URL is not trusted.");
        }

        Publish("downloading", offer.Version, null);
        var ownsClient = http == null;
        http ??= _http();
        try
        {
            var path = await DownloadAsync(http, offer, cancellationToken).ConfigureAwait(false);
            Publish("installing", offer.Version, null);
            _launcher.LaunchInstaller(path);
            _database.AddLog("Info", "Installing backup client " + offer.Version + ".");
            if (_exitDelay > TimeSpan.Zero)
            {
                await Task.Delay(_exitDelay, cancellationToken).ConfigureAwait(false);
            }

            ExitProcess?.Invoke();
        }
        finally
        {
            if (ownsClient)
            {
                http.Dispose();
            }
        }
    }

    private async Task<string> DownloadAsync(HttpClient http, ClientRelease offer, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_directory);
        var finalPath = Path.Combine(_directory, ClientInfo.InstallerFileName);
        var partial = finalPath + ".partial";
        using var response = await http.GetAsync(offer.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false))
        await using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        }

        var length = new FileInfo(partial).Length;
        if (length <= 0 || (offer.Size > 0 && length != offer.Size))
        {
            File.Delete(partial);
            throw new IOException("The downloaded installer does not match the published file.");
        }

        File.Move(partial, finalPath, overwrite: true);
        return finalPath;
    }

    private ClientRelease? CurrentOffer()
    {
        lock (_state)
        {
            return _offer;
        }
    }

    private void Publish(string state, string? availableVersion, string? detail)
    {
        lock (_state)
        {
            _snapshot = new UpdateSnapshot(ClientInfo.Version, availableVersion, state, detail);
        }
    }

    private static HttpClient CreateClient()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(20) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(ClientInfo.Name + "/" + ClientInfo.Version);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return http;
    }
}
