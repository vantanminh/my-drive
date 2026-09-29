using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace MyDrive.Backup;

public sealed class ControlServer
{
    private readonly BackupEngine _engine;
    private readonly string _pipeName;
    private readonly Action<ClientSettings>? _settingsApplied;

    public ControlServer(BackupEngine engine, string? pipeName = null, Action<ClientSettings>? settingsApplied = null)
    {
        _engine = engine;
        _pipeName = pipeName ?? ClientInfo.PipeName;
        _settingsApplied = settingsApplied;
    }

    public async Task ServeAsync(CancellationToken cancellationToken)
    {
        var inflight = new List<Task>();
        while (!cancellationToken.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = CreatePipe();
            }
            catch (Exception) when (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(150, cancellationToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                await server.DisposeAsync().ConfigureAwait(false);
                break;
            }
            catch (Exception)
            {
                await server.DisposeAsync().ConfigureAwait(false);
                continue;
            }

            inflight.Add(ServeClientAsync(server, cancellationToken));
            inflight.RemoveAll(task => task.IsCompleted);
        }

        try
        {
            await Task.WhenAll(inflight).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // A client that disconnects early must not stop the listener.
        }
    }

    private NamedPipeServerStream CreatePipe()
    {
        var options = PipeOptions.Asynchronous;
        if (OperatingSystem.IsWindows())
        {
            options |= PipeOptions.CurrentUserOnly;
        }

        return new NamedPipeServerStream(
            _pipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            options);
    }

    private async Task ServeClientAsync(NamedPipeServerStream server, CancellationToken cancellationToken)
    {
        using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        readTimeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var request = await PipeProtocol.ReadAsync(server, readTimeout.Token).ConfigureAwait(false);
            var response = await HandleAsync(request, cancellationToken).ConfigureAwait(false);
            await PipeProtocol.WriteAsync(server, response, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // An empty probe, or a client that closes before the response, only drops this connection.
        }
        finally
        {
            await server.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async Task<JsonElement> HandleAsync(JsonElement request, CancellationToken cancellationToken)
    {
        try
        {
            var method = request.TryGetProperty("method", out var methodElement) ? methodElement.GetString() : null;
            object result = method switch
            {
                "ping" => new { version = ClientInfo.Version },
                "status" => StatusPayload(),
                "jobs.list" => _engine.Jobs(),
                "jobs.upsert" => Upsert(request),
                "jobs.delete" => Delete(request),
                "pause" => Pause(request),
                "resume" => Resume(request),
                "pauseAll" => PauseAll(),
                "resumeAll" => ResumeAll(),
                "backup.now" => BackupNow(request),
                "queue" => _engine.Status().Transfers,
                "activity" => Activity(request),
                "settings.get" => _engine.Settings(),
                "settings.set" => SaveSettings(request),
                "logs.list" => Logs(),
                "logs.clear" => ClearLogs(request),
                "logs.export" => new { text = ExportLogs() },
                "server.test" => await _engine.TestServerAsync(Required(request, "url"), Bool(request, "allowInsecure"), cancellationToken),
                "server.set" => await _engine.SetServerAsync(Required(request, "url"), Bool(request, "allowInsecure"), Bool(request, "confirm"), cancellationToken),
                "auth.begin" => await _engine.BeginAuthorizationAsync(cancellationToken),
                "auth.status" => _engine.Authorization,
                "auth.logout" => await Logout(request, cancellationToken),
                "index.rebuild" => await Rebuild(request, cancellationToken),
                "integrity.verify" => await Verify(request, cancellationToken),
                "versions" => await _engine.VersionsAsync(Required(request, "fileId"), cancellationToken),
                "notifications.drain" => Notifications(),
                _ => throw new InvalidOperationException("Unknown control method."),
            };
            return Ok(result);
        }
        catch (ConfirmationRequiredException ex)
        {
            return Fail("confirmation_required", ex.Message);
        }
        catch (ServerCompatibilityException ex)
        {
            return Fail("incompatible_server", ex.Message);
        }
        catch (InsecureConnectionException ex)
        {
            return Fail("insecure_connection", ex.Message);
        }
        catch (Exception ex)
        {
            return Fail("error", SecretRedactor.Redact(ex.Message));
        }
    }

    private object StatusPayload()
    {
        var status = _engine.Status();
        status.Storage = _engine.LastStorage;
        status.AuthState = _engine.Authorization.State;
        status.AuthDetail = _engine.Authorization.Detail ?? _engine.Authorization.VerificationUri;
        status.AuthUserCode = _engine.Authorization.UserCode;
        return status;
    }

    private object Upsert(JsonElement request)
    {
        var job = request.GetProperty("job").Deserialize<BackupJob>(JsonOpts.Store) ?? throw new InvalidOperationException("Job is required.");
        _engine.SaveJob(job);
        return job;
    }

    private object Delete(JsonElement request)
    {
        if (!Bool(request, "confirm"))
        {
            throw new ConfirmationRequiredException("Removing a backup job does not delete files already stored on the server.");
        }

        _engine.DeleteJob(Required(request, "id"));
        return new { removed = true };
    }

    private object Pause(JsonElement request)
    {
        _engine.PauseJob(Required(request, "id"));
        return new { paused = true };
    }

    private object Resume(JsonElement request)
    {
        _engine.ResumeJob(Required(request, "id"));
        return new { paused = false };
    }

    private object PauseAll()
    {
        _engine.PauseAll();
        return new { paused = true };
    }

    private object ResumeAll()
    {
        _engine.ResumeAll();
        return new { paused = false };
    }

    private object BackupNow(JsonElement request)
    {
        _engine.BackupNow(Optional(request, "id"));
        return new { queued = true };
    }

    private object Activity(JsonElement request)
    {
        var filter = request.TryGetProperty("filter", out var filterElement) ? filterElement.GetString() : "All";
        return _engine.ListActivity(filter);
    }

    private object SaveSettings(JsonElement request)
    {
        var settings = request.GetProperty("settings").Deserialize<ClientSettings>(JsonOpts.Store) ?? new ClientSettings();
        _engine.SaveSettings(settings);
        _settingsApplied?.Invoke(_engine.Settings());
        return _engine.Settings();
    }

    private object Logs() => _engine.ListLogs();

    private object ClearLogs(JsonElement request)
    {
        if (!Bool(request, "confirm"))
        {
            throw new ConfirmationRequiredException("Clear the local troubleshooting log?");
        }

        _engine.ClearLogs();
        return new { cleared = true };
    }

    private string ExportLogs() => _engine.ExportLogs();

    private async Task<object> Logout(JsonElement request, CancellationToken cancellationToken)
    {
        if (!Bool(request, "confirm"))
        {
            throw new ConfirmationRequiredException("Disconnect this device from the server? Backup jobs stay on this computer, and cloud files stay on the server.");
        }

        await _engine.LogoutAsync(cancellationToken);
        return new { disconnected = true };
    }

    private async Task<object> Rebuild(JsonElement request, CancellationToken cancellationToken)
    {
        await _engine.RebuildIndexAsync(Bool(request, "confirm"), cancellationToken);
        return new { rebuilt = true };
    }

    private async Task<object> Verify(JsonElement request, CancellationToken cancellationToken)
    {
        await _engine.VerifyIntegrityAsync(Bool(request, "confirm"), cancellationToken);
        return new { verified = true };
    }

    private object Notifications() => _engine.DrainNotifications().Select(item => new { title = item.Title, body = item.Body }).ToArray();

    private static JsonElement Ok(object result)
    {
        var payload = JsonSerializer.SerializeToElement(new { ok = true, result }, JsonOpts.Store);
        return payload;
    }

    private static JsonElement Fail(string error, string message) =>
        JsonSerializer.SerializeToElement(new { ok = false, error, message }, JsonOpts.Store);

    private static string Required(JsonElement request, string name) =>
        request.TryGetProperty(name, out var value) ? value.GetString() ?? "" : "";

    private static string? Optional(JsonElement request, string name) =>
        request.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool Bool(JsonElement request, string name) =>
        request.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
}

public static class PipeProtocol
{
    public const int MaxBytes = 2_000_000;

    public static async Task<JsonElement> ReadAsync(Stream stream, CancellationToken cancellationToken)
    {
        var lengthBytes = new byte[4];
        await ReadExact(stream, lengthBytes, cancellationToken);
        if (!BitConverter.IsLittleEndian)
        {
            Array.Reverse(lengthBytes);
        }

        var length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > MaxBytes)
        {
            throw new InvalidOperationException("Control message is too large.");
        }

        var payload = new byte[length];
        await ReadExact(stream, payload, cancellationToken);
        using var document = JsonDocument.Parse(payload);
        return document.RootElement.Clone();
    }

    public static async Task WriteAsync(Stream stream, JsonElement payload, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        var length = BitConverter.GetBytes(bytes.Length);
        if (!BitConverter.IsLittleEndian)
        {
            Array.Reverse(length);
        }

        await stream.WriteAsync(length, cancellationToken);
        await stream.WriteAsync(bytes, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static PipeOptions ClientOptions => OperatingSystem.IsWindows()
        ? PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
        : PipeOptions.Asynchronous;

    public static async Task<JsonElement> RoundTripAsync(
        string pipeName,
        object request,
        CancellationToken cancellationToken,
        int connectTimeoutMs = 5000)
    {
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, ClientOptions);
        await client.ConnectAsync(connectTimeoutMs, cancellationToken);
        await WriteAsync(client, JsonSerializer.SerializeToElement(request, JsonOpts.Store), cancellationToken);
        return await ReadAsync(client, cancellationToken);
    }

    private static async Task ReadExact(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(read), cancellationToken);
            if (count == 0)
            {
                throw new EndOfStreamException("Control connection closed.");
            }

            read += count;
        }
    }
}
