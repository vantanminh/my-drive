using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using MyDrive.Backup;
using MyDrive.Backup.Agent;

var dataArgument = args.FirstOrDefault(argument => argument.StartsWith("--data=", StringComparison.Ordinal));
if (!string.IsNullOrWhiteSpace(dataArgument))
{
    ClientInfo.DataDirectory = dataArgument["--data=".Length..];
}

Directory.CreateDirectory(ClientInfo.DataDirectory);
var logPath = Path.Combine(ClientInfo.DataDirectory, "agent.log");
AgentLog.Write(logPath, "Backup service process started.");

if (args.Contains("--install-service"))
{
    ConsoleAttach.Parent();
    return WindowsStartup.TryInstallService();
}

await using var singleInstance = SingleInstance.TryAcquire(Path.Combine(ClientInfo.DataDirectory, "agent.lock"));
if (singleInstance == null)
{
    AgentLog.Write(logPath, "Backup service is already running.");
    return 0;
}

try
{
    var database = new LocalDatabase(Path.Combine(ClientInfo.DataDirectory, "backup.db"));
    ISecretStore secrets = OperatingSystem.IsWindows()
        ? new DpapiSecretStore(ClientInfo.DataDirectory)
        : new AesSecretStore(ClientInfo.DataDirectory);
    var engine = new BackupEngine(database, secrets);
    WindowsStartup.Apply(engine.Settings().StartWithWindows);

    var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
    {
        Args = args.Where(argument => !argument.StartsWith("--data=", StringComparison.Ordinal)).ToArray(),
        ContentRootPath = AppContext.BaseDirectory,
    });
    builder.Logging.ClearProviders();
    builder.Logging.SetMinimumLevel(LogLevel.Information);
    builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Warning);
    builder.Logging.AddProvider(new AgentFileLoggerProvider(logPath));
    if (OperatingSystem.IsWindows())
    {
        builder.Services.AddWindowsService(options => options.ServiceName = "MyDriveBackup");
    }

    builder.Services.AddSingleton(engine);
    builder.Services.AddSingleton(database);
    builder.Services.AddHostedService<AgentHost>();
    var host = builder.Build();
    await host.RunAsync();
    return 0;
}
catch (Exception ex)
{
    AgentLog.Write(logPath, ex.ToString());
    return 1;
}

internal static class AgentLog
{
    private static readonly object Gate = new();

    public static void Write(string path, string message)
    {
        try
        {
            lock (Gate)
            {
                File.AppendAllText(path, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
        }
    }
}

internal sealed class SingleInstance : IAsyncDisposable
{
    private readonly FileStream _stream;

    private SingleInstance(FileStream stream) => _stream = stream;

    public static SingleInstance? TryAcquire(string path)
    {
        try
        {
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            return new SingleInstance(stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public ValueTask DisposeAsync()
    {
        _stream.Dispose();
        return ValueTask.CompletedTask;
    }
}

internal static class ConsoleAttach
{
    public static void Parent()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            AttachConsole(-1);
        }
        catch (DllNotFoundException)
        {
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int dwProcessId);
}

internal sealed class AgentFileLoggerProvider(string path) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new AgentFileLogger(path, categoryName);

    public void Dispose()
    {
    }
}

internal sealed class AgentFileLogger(string path, string category) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
        {
            return;
        }

        var line = $"{logLevel} {category} {formatter(state, exception)}";
        if (exception != null)
        {
            line += " " + exception.GetType().Name + ": " + exception.Message;
        }

        AgentLog.Write(path, line);
    }
}

namespace MyDrive.Backup.Agent
{
    internal sealed class AgentHost(BackupEngine engine, IHostApplicationLifetime lifetime, ILogger<AgentHost> logger) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            var control = new ControlServer(engine, settingsApplied: WindowsStartup.Apply);
            logger.LogInformation("Backup service is listening.");
            try
            {
                await Task.WhenAll(engine.RunAsync(stoppingToken), control.ServeAsync(stoppingToken));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Backup service stopped.");
                lifetime.StopApplication();
            }
        }
    }
}
