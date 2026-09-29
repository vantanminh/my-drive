using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace MyDrive.Backup;

public sealed class ApiException : Exception
{
    public ApiException(int status, string code, int? interval = null, long? offset = null, string? message = null)
        : base(message ?? code)
    {
        Status = status;
        Code = code;
        Interval = interval;
        Offset = offset;
    }

    public int Status { get; }

    public string Code { get; }

    public int? Interval { get; }

    public long? Offset { get; }
}

public sealed class ServerCompatibilityException : Exception
{
    public ServerCompatibilityException()
        : base("This server is using an API version that is not supported by this client.")
    {
    }
}

public sealed class InsecureConnectionException : Exception
{
    public InsecureConnectionException()
        : base("Insecure connection. HTTP is allowed only when you explicitly accept it for a development or LAN server.")
    {
    }
}

public sealed class ConfirmationRequiredException : Exception
{
    public ConfirmationRequiredException(string message)
        : base(message)
    {
    }
}

public interface IDriveApi
{
    Task<ServerCapabilities> GetCapabilitiesAsync(CancellationToken cancellationToken);

    Task<DeviceCodeStart> StartDeviceCodeAsync(string deviceName, CancellationToken cancellationToken);

    Task<DevicePoll> PollDeviceCodeAsync(string deviceCode, CancellationToken cancellationToken);

    Task<TokenSet> RefreshAsync(string refreshToken, CancellationToken cancellationToken);

    Task<AccountProfile> GetAccountAsync(CancellationToken cancellationToken);

    Task<StorageQuota> GetStorageAsync(CancellationToken cancellationToken);

    Task HeartbeatAsync(CancellationToken cancellationToken);

    Task LogoutAsync(CancellationToken cancellationToken);

    Task<string> EnsureFolderAsync(string path, CancellationToken cancellationToken);

    Task<ContentCheck> CheckAsync(string? parentId, string name, long size, string hash, CancellationToken cancellationToken);

    Task<LinkResult> LinkAsync(string? parentId, string name, long size, string hash, DateTimeOffset? modified, CancellationToken cancellationToken);

    Task<UploadSessionInfo> CreateUploadAsync(string filename, long size, string? parentId, string? fileId, DateTimeOffset? modified, CancellationToken cancellationToken);

    Task<long> HeadOffsetAsync(string uploadId, CancellationToken cancellationToken);

    Task<long> PatchAsync(string uploadId, long offset, byte[] data, int count, CancellationToken cancellationToken);

    Task<FinalizeResult> FinalizeAsync(string uploadId, string sha256, CancellationToken cancellationToken);

    Task TrashAsync(string fileId, CancellationToken cancellationToken);

    Task RenameAsync(string fileId, string name, CancellationToken cancellationToken);

    Task MoveAsync(string fileId, string parentId, CancellationToken cancellationToken);

    Task<IReadOnlyList<RemoteVersion>> VersionsAsync(string fileId, CancellationToken cancellationToken);
}

public sealed class DriveApiClient : IDriveApi, IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsClient;

    public DriveApiClient(Uri server, Func<string?> accessToken, bool allowInsecure, HttpMessageHandler? handler = null)
    {
        ServerAddress.Validate(server, allowInsecure);
        _ownsClient = handler == null;
        var http = handler == null ? new HttpClient(CreateHandler()) : new HttpClient(handler, disposeHandler: false);
        http.BaseAddress = server;
        http.Timeout = TimeSpan.FromMinutes(10);
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"{ClientInfo.Name}/{ClientInfo.Version}");
        http.DefaultRequestHeaders.TryAddWithoutValidation("X-Client-Version", ClientInfo.Version);
        _http = http;
        AccessToken = accessToken;
    }

    public Func<string?> AccessToken { get; }

    public void Dispose()
    {
        if (_ownsClient)
        {
            _http.Dispose();
        }
    }

    public async Task<ServerCapabilities> GetCapabilitiesAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/.well-known/cloud-client", null, authenticate: false, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        var features = document.RootElement.GetProperty("features");
        var upload = document.RootElement.TryGetProperty("upload", out var uploadElement) ? uploadElement : default;
        return new ServerCapabilities
        {
            Product = Text(document.RootElement, "product"),
            ApiVersion = Text(document.RootElement, "apiVersion"),
            ServerVersion = Text(document.RootElement, "serverVersion"),
            MinClientApi = Text(document.RootElement, "minClientApi"),
            MaxClientApi = Text(document.RootElement, "maxClientApi"),
            ChunkedUpload = Bool(features, "chunkedUpload"),
            ResumableUpload = Bool(features, "resumableUpload"),
            Deduplication = Bool(features, "deduplication"),
            FileVersions = Bool(features, "fileVersions"),
            DeviceAuthorization = Bool(features, "deviceAuthorization"),
            ContentHash = Text(features, "contentHash"),
            MaxChunkBytes = upload.ValueKind == JsonValueKind.Object && upload.TryGetProperty("maxChunkBytes", out var max)
                ? max.GetInt64()
                : 64 * 1024 * 1024,
        };
    }

    public async Task<DeviceCodeStart> StartDeviceCodeAsync(string deviceName, CancellationToken cancellationToken)
    {
        var body = new
        {
            client_name = ClientInfo.Name,
            client_version = ClientInfo.Version,
            device_name = deviceName,
            operating_system = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
        };
        using var response = await SendAsync(HttpMethod.Post, "/api/device/code", body, authenticate: false, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        var root = document.RootElement;
        return new DeviceCodeStart
        {
            DeviceCode = Required(root, "device_code"),
            UserCode = Required(root, "user_code"),
            VerificationUri = Required(root, "verification_uri"),
            VerificationUriComplete = Required(root, "verification_uri_complete"),
            ExpiresIn = root.GetProperty("expires_in").GetInt32(),
            Interval = root.GetProperty("interval").GetInt32(),
        };
    }

    public async Task<DevicePoll> PollDeviceCodeAsync(string deviceCode, CancellationToken cancellationToken)
    {
        var body = new
        {
            grant_type = "urn:ietf:params:oauth:grant-type:device_code",
            device_code = deviceCode,
        };
        using var response = await SendRaw(HttpMethod.Post, "/api/device/token", body, authenticate: false, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var error = await Error(response, cancellationToken);
            return error.Code switch
            {
                "authorization_pending" => new DevicePoll { Pending = true, IntervalSeconds = error.Interval ?? 5 },
                "slow_down" => new DevicePoll { Pending = true, SlowDown = true, IntervalSeconds = error.Interval ?? 5 },
                "access_denied" => new DevicePoll { Denied = true, Error = error.Code },
                "expired_token" => new DevicePoll { Expired = true, Error = error.Code },
                _ => new DevicePoll { Error = error.Code },
            };
        }

        var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return new DevicePoll { Authorized = true, Tokens = ReadTokens(document.RootElement) };
    }

    public async Task<TokenSet> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var body = new { grant_type = "refresh_token", refresh_token = refreshToken };
        using var response = await SendAsync(HttpMethod.Post, "/api/device/refresh", body, authenticate: false, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        return ReadTokens(document.RootElement);
    }

    public async Task<AccountProfile> GetAccountAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/auth/me", null, authenticate: true, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        return new AccountProfile
        {
            Id = Required(document.RootElement, "id"),
            Email = Required(document.RootElement, "email"),
            Role = Text(document.RootElement, "role"),
        };
    }

    public async Task<StorageQuota> GetStorageAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/storage", null, authenticate: true, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        var root = document.RootElement;
        long files = 0;
        if (root.TryGetProperty("by_category", out var categories) && categories.ValueKind == JsonValueKind.Array)
        {
            foreach (var category in categories.EnumerateArray())
            {
                if (category.TryGetProperty("file_count", out var count))
                {
                    files += count.GetInt64();
                }
            }
        }

        return new StorageQuota
        {
            QuotaBytes = LongOrNull(root, "quota_bytes"),
            UsedBytes = Long(root, "used_bytes"),
            ReservedBytes = Long(root, "reserved_bytes"),
            AvailableBytes = LongOrNull(root, "available_bytes"),
            PercentUsed = root.TryGetProperty("percent_used", out var percent) && percent.ValueKind == JsonValueKind.Number ? percent.GetDouble() : null,
            Unlimited = Bool(root, "unlimited"),
            FileCount = files,
        };
    }

    public Task HeartbeatAsync(CancellationToken cancellationToken) =>
        SendEmpty(HttpMethod.Post, "/api/device/heartbeat", cancellationToken);

    public Task LogoutAsync(CancellationToken cancellationToken) =>
        SendEmpty(HttpMethod.Post, "/api/device/logout", cancellationToken);

    public async Task<string> EnsureFolderAsync(string path, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Post, "/api/backup/folders", new { path }, true, cancellationToken);
        var document = await ReadDocument(response, cancellationToken);
        return Required(document.RootElement, "id");
    }

    public async Task<ContentCheck> CheckAsync(string? parentId, string name, long size, string hash, CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?>
        {
            ["name"] = name,
            ["size_bytes"] = size,
            ["checksum_sha256"] = hash,
        };
        if (parentId != null)
        {
            body["parent_id"] = parentId;
        }

        using var response = await SendAsync(HttpMethod.Post, "/api/backup/check", body, true, cancellationToken);
        var root = (await ReadDocument(response, cancellationToken)).RootElement;
        return new ContentCheck
        {
            Action = Required(root, "action"),
            FileId = Optional(root, "file_id"),
            VersionId = Optional(root, "version_id"),
            RemoteChecksum = Optional(root, "remote_checksum"),
            Reusable = Bool(root, "reusable"),
        };
    }

    public async Task<LinkResult> LinkAsync(string? parentId, string name, long size, string hash, DateTimeOffset? modified, CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?>
        {
            ["name"] = name,
            ["size_bytes"] = size,
            ["checksum_sha256"] = hash,
        };
        if (parentId != null)
        {
            body["parent_id"] = parentId;
        }

        if (modified != null)
        {
            body["modified_at"] = modified.Value.UtcDateTime.ToString("O");
        }

        using var response = await SendAsync(HttpMethod.Post, "/api/backup/link", body, true, cancellationToken);
        var root = (await ReadDocument(response, cancellationToken)).RootElement;
        return new LinkResult
        {
            FileId = Required(root, "file_id"),
            VersionId = Required(root, "version_id"),
            Checksum = Required(root, "checksum_sha256"),
            Unchanged = Bool(root, "unchanged"),
        };
    }

    public async Task<UploadSessionInfo> CreateUploadAsync(string filename, long size, string? parentId, string? fileId, DateTimeOffset? modified, CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?>
        {
            ["filename"] = filename,
            ["expected_size"] = size,
        };
        if (parentId != null)
        {
            body["parent_id"] = parentId;
        }

        if (fileId != null)
        {
            body["file_id"] = fileId;
        }

        if (modified != null)
        {
            body["original_modified_at"] = modified.Value.UtcDateTime.ToString("O");
        }

        using var response = await SendAsync(HttpMethod.Post, "/api/uploads", body, true, cancellationToken);
        var root = (await ReadDocument(response, cancellationToken)).RootElement;
        return new UploadSessionInfo
        {
            Id = Required(root, "id"),
            Offset = Long(root, "offset"),
            Length = Long(root, "length"),
        };
    }

    public async Task<long> HeadOffsetAsync(string uploadId, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Head, "/api/uploads/" + uploadId, null, true, cancellationToken);
        return OffsetHeader(response) ?? 0;
    }

    public async Task<long> PatchAsync(string uploadId, long offset, byte[] data, int count, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, "/api/uploads/" + uploadId);
        var content = new ByteArrayContent(data, 0, count);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/offset+octet-stream");
        content.Headers.ContentLength = count;
        request.Content = content;
        request.Headers.TryAddWithoutValidation("Upload-Offset", offset.ToString());
        request.Headers.TryAddWithoutValidation("Tus-Resumable", "1.0.0");
        ApplyAuth(request);
        using var response = await _http.SendAsync(request, cancellationToken);
        if ((int)response.StatusCode == 409)
        {
            var error = await Error(response, cancellationToken);
            throw new ApiException(409, error.Code, error.Interval, OffsetHeader(response) ?? error.Offset);
        }

        await EnsureSuccess(response, cancellationToken);
        return OffsetHeader(response) ?? offset + count;
    }

    public async Task<FinalizeResult> FinalizeAsync(string uploadId, string sha256, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/uploads/" + uploadId + "/finalize");
        request.Headers.TryAddWithoutValidation("X-Content-SHA256", sha256);
        ApplyAuth(request);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccess(response, cancellationToken);
        var root = (await ReadDocument(response, cancellationToken)).RootElement;
        return new FinalizeResult
        {
            FileId = Required(root, "file_id"),
            VersionId = Optional(root, "version_id"),
            Checksum = Optional(root, "checksum_sha256"),
        };
    }

    public Task TrashAsync(string fileId, CancellationToken cancellationToken) =>
        SendEmpty(HttpMethod.Delete, "/api/entries/" + fileId, cancellationToken);

    public Task RenameAsync(string fileId, string name, CancellationToken cancellationToken) =>
        SendEmptyBody(HttpMethod.Patch, "/api/entries/" + fileId + "/rename", new { name }, cancellationToken);

    public Task MoveAsync(string fileId, string parentId, CancellationToken cancellationToken) =>
        SendEmptyBody(HttpMethod.Post, "/api/entries/" + fileId + "/move", new { parent_id = parentId }, cancellationToken);

    public async Task<IReadOnlyList<RemoteVersion>> VersionsAsync(string fileId, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/files/" + fileId + "/versions", null, true, cancellationToken);
        var root = (await ReadDocument(response, cancellationToken)).RootElement;
        var versions = new List<RemoteVersion>();
        if (!root.TryGetProperty("versions", out var array))
        {
            return versions;
        }

        foreach (var item in array.EnumerateArray())
        {
            versions.Add(new RemoteVersion
            {
                Id = Required(item, "id"),
                SizeBytes = Long(item, "size_bytes"),
                Checksum = Optional(item, "checksum_sha256"),
                CreatedAt = item.TryGetProperty("created_at", out var created) ? created.GetDateTimeOffset() : DateTimeOffset.UnixEpoch,
                Current = Bool(item, "current"),
            });
        }

        return versions;
    }

    private async Task SendEmpty(HttpMethod method, string path, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(method, path, null, true, cancellationToken);
    }

    private async Task SendEmptyBody(HttpMethod method, string path, object body, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(method, path, body, true, cancellationToken);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, bool authenticate, CancellationToken cancellationToken)
    {
        var response = await SendRaw(method, path, body, authenticate, cancellationToken);
        await EnsureSuccess(response, cancellationToken);
        return response;
    }

    private async Task<HttpResponseMessage> SendRaw(HttpMethod method, string path, object? body, bool authenticate, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body != null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        }

        if (authenticate)
        {
            ApplyAuth(request);
        }

        return await _http.SendAsync(request, cancellationToken);
    }

    private void ApplyAuth(HttpRequestMessage request)
    {
        var token = AccessToken();
        if (!string.IsNullOrEmpty(token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    private static HttpClientHandler CreateHandler() => new()
    {
        // Certificate validation stays on. HTTP is a separate, explicit choice.
        AllowAutoRedirect = false,
    };

    private static async Task EnsureSuccess(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var error = await Error(response, cancellationToken);
        throw new ApiException((int)response.StatusCode, error.Code, error.Interval, error.Offset ?? OffsetHeader(response));
    }

    private static async Task<ApiException> Error(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        string code = "request_failed";
        int? interval = null;
        long? offset = OffsetHeader(response);
        try
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            if (text.Length > 0)
            {
                using var document = JsonDocument.Parse(text);
                if (document.RootElement.TryGetProperty("error", out var error))
                {
                    code = error.GetString() ?? code;
                }

                if (document.RootElement.TryGetProperty("interval", out var seconds) && seconds.TryGetInt32(out var value))
                {
                    interval = value;
                }
            }
        }
        catch (JsonException)
        {
        }

        return new ApiException((int)response.StatusCode, code, interval, offset);
    }

    private static async Task<JsonDocument> ReadDocument(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private static TokenSet ReadTokens(JsonElement root) => new()
    {
        AccessToken = Required(root, "access_token"),
        RefreshToken = Required(root, "refresh_token"),
        ExpiresIn = root.TryGetProperty("expires_in", out var expires) ? expires.GetInt32() : 3600,
        DeviceId = Required(root, "device_id"),
    };

    private static long? OffsetHeader(HttpResponseMessage response)
    {
        if (response.Headers.TryGetValues("Upload-Offset", out var values) && long.TryParse(values.FirstOrDefault(), out var offset))
        {
            return offset;
        }

        return null;
    }

    private static string Required(JsonElement element, string name) => element.GetProperty(name).GetString() ?? "";

    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private static string? Optional(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool Bool(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static long Long(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) ? number : 0;

    private static long? LongOrNull(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : null;
}

public static class ServerAddress
{
    public static Uri Normalize(string input, bool allowInsecure)
    {
        var text = input.Trim().TrimEnd('/');
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            throw new InvalidOperationException("Enter the full URL of your server.");
        }

        Validate(uri, allowInsecure);
        var builder = new UriBuilder(uri) { Path = "", Query = "", Fragment = "" };
        return builder.Uri;
    }

    public static void Validate(Uri uri, bool allowInsecure)
    {
        if (uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase))
        {
            if (!allowInsecure)
            {
                throw new InsecureConnectionException();
            }

            return;
        }

        if (!uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Server URL must use HTTPS, or HTTP when you accept an insecure connection.");
        }
    }

    public static void EnsureCompatible(ServerCapabilities capabilities)
    {
        if (!int.TryParse(capabilities.ApiVersion, out var version) || version != int.Parse(ClientInfo.ApiVersion))
        {
            throw new ServerCompatibilityException();
        }

        if (int.TryParse(capabilities.MinClientApi, out var min) && int.Parse(ClientInfo.ApiVersion) < min)
        {
            throw new ServerCompatibilityException();
        }

        if (int.TryParse(capabilities.MaxClientApi, out var max) && int.Parse(ClientInfo.ApiVersion) > max)
        {
            throw new ServerCompatibilityException();
        }
    }
}

public sealed class RefreshingDriveApi : IDriveApi
{
    private readonly Uri _server;
    private readonly ISecretStore _secrets;
    private readonly SemaphoreSlim _refresh = new(1, 1);
    private readonly DriveApiClient _client;
    private string? _access;

    public RefreshingDriveApi(Uri server, bool allowInsecure, ISecretStore secrets, HttpMessageHandler? handler = null)
    {
        _server = server;
        _secrets = secrets;
        _access = secrets.Load(SecretKeys.Access(server.ToString().TrimEnd('/')));
        _client = new DriveApiClient(server, () => _access, allowInsecure, handler);
    }

    public Task<ServerCapabilities> GetCapabilitiesAsync(CancellationToken cancellationToken) =>
        Call(api => api.GetCapabilitiesAsync(cancellationToken), cancellationToken);

    public Task<DeviceCodeStart> StartDeviceCodeAsync(string deviceName, CancellationToken cancellationToken) =>
        WithClient(api => api.StartDeviceCodeAsync(deviceName, cancellationToken));

    public Task<DevicePoll> PollDeviceCodeAsync(string deviceCode, CancellationToken cancellationToken) =>
        WithClient(api => api.PollDeviceCodeAsync(deviceCode, cancellationToken));

    public async Task<TokenSet> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var tokens = await WithClient(api => api.RefreshAsync(refreshToken, cancellationToken));
        Store(tokens);
        return tokens;
    }

    public Task<AccountProfile> GetAccountAsync(CancellationToken cancellationToken) =>
        Call(api => api.GetAccountAsync(cancellationToken), cancellationToken);

    public Task<StorageQuota> GetStorageAsync(CancellationToken cancellationToken) =>
        Call(api => api.GetStorageAsync(cancellationToken), cancellationToken);

    public Task HeartbeatAsync(CancellationToken cancellationToken) =>
        Call(api => api.HeartbeatAsync(cancellationToken), cancellationToken);

    public Task LogoutAsync(CancellationToken cancellationToken) =>
        Call(api => api.LogoutAsync(cancellationToken), cancellationToken);

    public Task<string> EnsureFolderAsync(string path, CancellationToken cancellationToken) =>
        Call(api => api.EnsureFolderAsync(path, cancellationToken), cancellationToken);

    public Task<ContentCheck> CheckAsync(string? parentId, string name, long size, string hash, CancellationToken cancellationToken) =>
        Call(api => api.CheckAsync(parentId, name, size, hash, cancellationToken), cancellationToken);

    public Task<LinkResult> LinkAsync(string? parentId, string name, long size, string hash, DateTimeOffset? modified, CancellationToken cancellationToken) =>
        Call(api => api.LinkAsync(parentId, name, size, hash, modified, cancellationToken), cancellationToken);

    public Task<UploadSessionInfo> CreateUploadAsync(string filename, long size, string? parentId, string? fileId, DateTimeOffset? modified, CancellationToken cancellationToken) =>
        Call(api => api.CreateUploadAsync(filename, size, parentId, fileId, modified, cancellationToken), cancellationToken);

    public Task<long> HeadOffsetAsync(string uploadId, CancellationToken cancellationToken) =>
        Call(api => api.HeadOffsetAsync(uploadId, cancellationToken), cancellationToken);

    public Task<long> PatchAsync(string uploadId, long offset, byte[] data, int count, CancellationToken cancellationToken) =>
        Call(api => api.PatchAsync(uploadId, offset, data, count, cancellationToken), cancellationToken);

    public Task<FinalizeResult> FinalizeAsync(string uploadId, string sha256, CancellationToken cancellationToken) =>
        Call(api => api.FinalizeAsync(uploadId, sha256, cancellationToken), cancellationToken);

    public Task TrashAsync(string fileId, CancellationToken cancellationToken) =>
        Call(api => api.TrashAsync(fileId, cancellationToken), cancellationToken);

    public Task RenameAsync(string fileId, string name, CancellationToken cancellationToken) =>
        Call(api => api.RenameAsync(fileId, name, cancellationToken), cancellationToken);

    public Task MoveAsync(string fileId, string parentId, CancellationToken cancellationToken) =>
        Call(api => api.MoveAsync(fileId, parentId, cancellationToken), cancellationToken);

    public Task<IReadOnlyList<RemoteVersion>> VersionsAsync(string fileId, CancellationToken cancellationToken) =>
        Call(api => api.VersionsAsync(fileId, cancellationToken), cancellationToken);

    private async Task<T> Call<T>(Func<DriveApiClient, Task<T>> action, CancellationToken cancellationToken)
    {
        try
        {
            return await WithClient(action);
        }
        catch (ApiException ex) when (ex.Status == 401)
        {
            await RefreshStored(cancellationToken);
            return await WithClient(action);
        }
    }

    private async Task Call(Func<DriveApiClient, Task> action, CancellationToken cancellationToken)
    {
        try
        {
            await WithClient(action);
        }
        catch (ApiException ex) when (ex.Status == 401)
        {
            await RefreshStored(cancellationToken);
            await WithClient(action);
        }
    }

    private Task<T> WithClient<T>(Func<DriveApiClient, Task<T>> action) => action(_client);

    private Task WithClient(Func<DriveApiClient, Task> action) => action(_client);

    private async Task RefreshStored(CancellationToken cancellationToken)
    {
        await _refresh.WaitAsync(cancellationToken);
        try
        {
            var refresh = _secrets.Load(SecretKeys.Refresh(_server.ToString().TrimEnd('/')));
            if (string.IsNullOrEmpty(refresh))
            {
                throw new ApiException(401, "authentication_required");
            }

            var tokens = await WithClient(api => api.RefreshAsync(refresh, cancellationToken));
            Store(tokens);
        }
        finally
        {
            _refresh.Release();
        }
    }

    private void Store(TokenSet tokens)
    {
        var server = _server.ToString().TrimEnd('/');
        _access = tokens.AccessToken;
        _secrets.Save(SecretKeys.Access(server), tokens.AccessToken);
        _secrets.Save(SecretKeys.Refresh(server), tokens.RefreshToken);
    }
}
