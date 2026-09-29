using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using MyDrive.Backup;

namespace MyDrive.Backup.App;

public sealed class BackupServiceUnavailableException(string message) : InvalidOperationException(message);

public static class AgentConnection
{
    private static readonly SemaphoreSlim StartGate = new(1, 1);

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

        await StartGate.WaitAsync(cancellationToken);
        try
        {
            if (await ProbeAsync(cancellationToken))
            {
                return;
            }

            if (!AgentIsRunning())
            {
                LaunchAgent();
            }

            if (await WaitForServiceAsync(cancellationToken, TimeSpan.FromSeconds(12)))
            {
                return;
            }

            await StopAgentsAsync();
            LaunchAgent();
            if (await WaitForServiceAsync(cancellationToken, TimeSpan.FromSeconds(15)))
            {
                return;
            }

            throw new BackupServiceUnavailableException(FailureMessage());
        }
        finally
        {
            StartGate.Release();
        }
    }

    private static async Task<bool> WaitForServiceAsync(CancellationToken cancellationToken, TimeSpan budget)
    {
        var started = Environment.TickCount64;
        var limit = (long)budget.TotalMilliseconds;
        while (Environment.TickCount64 - started < limit)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await ProbeAsync(cancellationToken))
            {
                return true;
            }

            await Task.Delay(200, cancellationToken);
        }

        return false;
    }

    private static async Task<bool> ProbeAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(400));
            var response = await PipeProtocol.RoundTripAsync(ClientInfo.PipeName, new { method = "ping" }, timeout.Token);
            return response.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or InvalidOperationException or OperationCanceledException or EndOfStreamException)
        {
            return false;
        }
    }

    private static void LaunchAgent()
    {
        var executable = FindAgent();
        if (executable == null)
        {
            throw new BackupServiceUnavailableException("The backup service was not found next to this app.");
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory,
            });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new BackupServiceUnavailableException("The backup service could not be launched.");
        }
    }

    private static bool AgentIsRunning()
    {
        try
        {
            var processes = Process.GetProcessesByName("MyDrive.Backup.Agent");
            try
            {
                return processes.Length > 0;
            }
            finally
            {
                foreach (var process in processes)
                {
                    process.Dispose();
                }
            }
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static async Task StopAgentsAsync()
    {
        var stopped = false;
        try
        {
            foreach (var process in Process.GetProcessesByName("MyDrive.Backup.Agent"))
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                    stopped = true;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
                {
                }
                finally
                {
                    process.Dispose();
                }
            }
        }
        catch (InvalidOperationException)
        {
        }

        if (stopped)
        {
            await Task.Delay(400);
        }
    }

    private static string FailureMessage()
    {
        var detail = TailLog();
        var message = "The backup service did not start.";
        return string.IsNullOrWhiteSpace(detail) ? message : message + " " + detail;
    }

    private static string TailLog()
    {
        try
        {
            var path = Path.Combine(ClientInfo.DataDirectory, "agent.log");
            if (!File.Exists(path))
            {
                return "";
            }

            var lines = File.ReadAllLines(path);
            return string.Join(" ", lines.TakeLast(2));
        }
        catch (IOException)
        {
            return "";
        }
    }

    private static string? FindAgent()
    {
        var file = Path.Combine(AppContext.BaseDirectory, "MyDrive.Backup.Agent.exe");
        if (File.Exists(file))
        {
            return file;
        }

        foreach (var configuration in new[] { "Debug", "Release" })
        {
            var dev = Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory,
                "..", "..", "..", "..",
                "MyDrive.Backup.Agent", "bin", configuration, "net8.0",
                "MyDrive.Backup.Agent.exe"));
            if (File.Exists(dev))
            {
                return dev;
            }
        }

        return null;
    }
}
