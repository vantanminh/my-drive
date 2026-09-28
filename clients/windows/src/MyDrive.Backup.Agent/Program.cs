using MyDrive.Backup;
using MyDrive.Backup.Agent;

var dataArgument = args.FirstOrDefault(argument => argument.StartsWith("--data=", StringComparison.Ordinal));
if (!string.IsNullOrWhiteSpace(dataArgument))
{
    ClientInfo.DataDirectory = dataArgument["--data=".Length..];
}

Directory.CreateDirectory(ClientInfo.DataDirectory);
if (args.Contains("--install-service"))
{
    return WindowsStartup.TryInstallService();
}

var database = new LocalDatabase(Path.Combine(ClientInfo.DataDirectory, "backup.db"));
ISecretStore secrets = OperatingSystem.IsWindows()
    ? new DpapiSecretStore(ClientInfo.DataDirectory)
    : new AesSecretStore(ClientInfo.DataDirectory);
var engine = new BackupEngine(database, secrets);
WindowsStartup.Apply(engine.Settings().StartWithWindows);

var builder = Host.CreateApplicationBuilder(args);
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

namespace MyDrive.Backup.Agent
{
    internal sealed class AgentHost(BackupEngine engine, IHostApplicationLifetime lifetime) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            var control = new ControlServer(engine, settingsApplied: WindowsStartup.Apply);
            try
            {
                await Task.WhenAll(engine.RunAsync(stoppingToken), control.ServeAsync(stoppingToken));
            }
            catch (IOException)
            {
                Console.Error.WriteLine("My Drive Backup is already running.");
                lifetime.StopApplication();
            }
        }
    }
}
