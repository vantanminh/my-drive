using System.Diagnostics;
using System.Text.Json;
using MyDrive.Backup;

namespace MyDrive.Backup.App;

public sealed class BackupServiceUnavailableException(string message) : InvalidOperationException(message);

public static class AgentConnection
{
    private static readonly SemaphoreSlim StartGate = new(1, 1);
    private static Process? _launched;
    private static LocalBackupService? _embedded;

    public static Task<JsonElement> CallAsync(object request, CancellationToken cancellationToken = default)
    {
        return CallCoreAsync(request, cancellationToken);
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

            if (await WaitForServiceAsync(cancellationToken, TimeSpan.FromSeconds(20)))
            {
                return;
            }

            await StopAgentsAsync();
            LaunchAgent();
            if (await WaitForServiceAsync(cancellationToken, TimeSpan.FromSeconds(15)))
            {
                return;
            }

            await StopAgentsAsync();
            if (await StartEmbeddedAsync(cancellationToken))
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

    private static async Task<JsonElement> CallCoreAsync(object request, CancellationToken cancellationToken)
    {
        await EnsureAgentAsync(cancellationToken);
        return await PipeProtocol.RoundTripAsync(ClientInfo.PipeName, request, cancellationToken);
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

            if (LaunchedProcessExited())
            {
                return false;
            }

            if (!AgentIsRunning() && Environment.TickCount64 - started > 1000)
            {
                return false;
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
            timeout.CancelAfter(TimeSpan.FromMilliseconds(800));
            var response = await PipeProtocol.RoundTripAsync(
                ClientInfo.PipeName,
                new { method = "ping" },
                timeout.Token,
                connectTimeoutMs: 400);
            return response.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or InvalidOperationException or OperationCanceledException or EndOfStreamException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static async Task<bool> StartEmbeddedAsync(CancellationToken cancellationToken)
    {
        if (_embedded != null)
        {
            return await WaitForPipeAsync(cancellationToken, TimeSpan.FromSeconds(5));
        }

        for (var attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                _embedded = LocalBackupService.Start(settingsApplied: settings =>
                    CurrentUserStartup.Apply(settings.StartWithWindows, FindAgent()));
                AppendLog("Backup service is running inside the app.");
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (attempt == 7)
                {
                    AppendLog("In-process backup service could not start: " + ex.Message);
                    return false;
                }

                await Task.Delay(250, cancellationToken);
            }
        }

        return await WaitForPipeAsync(cancellationToken, TimeSpan.FromSeconds(8));
    }

    private static async Task<bool> WaitForPipeAsync(CancellationToken cancellationToken, TimeSpan budget)
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

    private static void LaunchAgent()
    {
        ReleaseLaunched();
        var executable = FindAgent();
        if (executable == null)
        {
            AppendLog("Backup service executable was not found.");
            return;
        }

        try
        {
            Directory.CreateDirectory(ClientInfo.DataDirectory);
            var start = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("--data=" + ClientInfo.DataDirectory);
            var process = Process.Start(start);
            if (process == null)
            {
                AppendLog("Backup service process did not start.");
                return;
            }

            process.OutputDataReceived += (_, args) => AppendLog(args.Data);
            process.ErrorDataReceived += (_, args) => AppendLog(args.Data);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _launched = process;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            AppendLog("Backup service could not be launched: " + ex.Message);
        }
    }

    private static bool LaunchedProcessExited()
    {
        var process = _launched;
        if (process == null)
        {
            return false;
        }

        try
        {
            if (!process.HasExited)
            {
                return false;
            }

            AppendLog("Backup service process exited with code " + process.ExitCode + ".");
            return true;
        }
        catch (InvalidOperationException)
        {
            return true;
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
        ReleaseLaunched();
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

    private static void ReleaseLaunched()
    {
        var process = _launched;
        _launched = null;
        if (process == null)
        {
            return;
        }

        try
        {
            process.CancelOutputRead();
            process.CancelErrorRead();
        }
        catch (InvalidOperationException)
        {
        }

        process.Dispose();
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
            return string.Join(" ", lines.TakeLast(4));
        }
        catch (IOException)
        {
            return "";
        }
    }

    private static void AppendLog(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        try
        {
            var directory = ClientInfo.DataDirectory;
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "agent.log"), $"{DateTimeOffset.Now:O} {line}{Environment.NewLine}");
        }
        catch (IOException)
        {
        }
    }

    private static string? FindAgent()
    {
        foreach (var relative in new[] { Path.Combine("agent", "MyDrive.Backup.Agent.exe"), "MyDrive.Backup.Agent.exe" })
        {
            var file = Path.Combine(AppContext.BaseDirectory, relative);
            if (File.Exists(file))
            {
                return file;
            }
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
