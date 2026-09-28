using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using MyDrive.Backup;

namespace MyDrive.Backup.App;

public static class AgentConnection
{
    public static async Task<JsonElement> CallAsync(object request, CancellationToken cancellationToken = default)
    {
        await EnsureAgentAsync(cancellationToken);
        using var client = new NamedPipeClientStream(".", ClientInfo.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(4000, cancellationToken);
        var payload = JsonSerializer.SerializeToElement(request, JsonOpts.Store);
        await PipeProtocol.WriteAsync(client, payload, cancellationToken);
        return await PipeProtocol.ReadAsync(client, cancellationToken);
    }

    public static async Task EnsureAgentAsync(CancellationToken cancellationToken)
    {
        if (await ProbeAsync(cancellationToken))
        {
            return;
        }

        var executable = FindAgent();
        if (executable == null)
        {
            throw new InvalidOperationException("The backup service was not found next to this app.");
        }

        Process.Start(new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory,
        });
        for (var attempt = 0; attempt < 20; attempt++)
        {
            if (await ProbeAsync(cancellationToken))
            {
                return;
            }

            await Task.Delay(250, cancellationToken);
        }

        throw new InvalidOperationException("The backup service did not start.");
    }

    private static async Task<bool> ProbeAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", ClientInfo.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(200, cancellationToken);
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or InvalidOperationException)
        {
            return false;
        }
    }

    private static string? FindAgent()
    {
        var file = Path.Combine(AppContext.BaseDirectory, "MyDrive.Backup.Agent.exe");
        if (File.Exists(file))
        {
            return file;
        }

        var dev = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "MyDrive.Backup.Agent", "bin", "Debug", "net8.0", "MyDrive.Backup.Agent.exe"));
        return File.Exists(dev) ? dev : null;
    }
}
