namespace MyDrive.Backup;

/// <summary>
/// Runs the backup engine and its pipe server in this process. The desktop app
/// uses it when the separate agent executable never starts listening.
/// </summary>
public sealed class LocalBackupService : IAsyncDisposable
{
    private readonly FileStream _instance;
    private readonly LocalDatabase _database;
    private readonly BackupEngine _engine;
    private readonly CancellationTokenSource _cancellation;
    private readonly Task _run;

    private LocalBackupService(
        FileStream instance,
        LocalDatabase database,
        BackupEngine engine,
        CancellationTokenSource cancellation,
        Task run)
    {
        _instance = instance;
        _database = database;
        _engine = engine;
        _cancellation = cancellation;
        _run = run;
    }

    public static LocalBackupService Start(string? dataDirectory = null, string? pipeName = null, Action<ClientSettings>? settingsApplied = null)
    {
        var directory = string.IsNullOrWhiteSpace(dataDirectory) ? ClientInfo.DataDirectory : dataDirectory;
        Directory.CreateDirectory(directory);
        var instance = OpenInstance(directory);
        LocalDatabase? database = null;
        BackupEngine? engine = null;
        var cancellation = new CancellationTokenSource();
        try
        {
            database = new LocalDatabase(Path.Combine(directory, "backup.db"));
            ISecretStore secrets = OperatingSystem.IsWindows()
                ? new DpapiSecretStore(directory)
                : new AesSecretStore(directory);
            engine = new BackupEngine(database, secrets);
            var control = new ControlServer(engine, pipeName, settingsApplied);
            var run = Task.WhenAll(
                engine.RunAsync(cancellation.Token),
                control.ServeAsync(cancellation.Token));
            return new LocalBackupService(instance, database, engine, cancellation, run);
        }
        catch
        {
            cancellation.Dispose();
            engine?.Dispose();
            database?.Dispose();
            instance.Dispose();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cancellation.Cancel();
        try
        {
            await _run.ConfigureAwait(false);
        }
        catch (Exception)
        {
        }

        _cancellation.Dispose();
        _engine.Dispose();
        _database.Dispose();
        await _instance.DisposeAsync().ConfigureAwait(false);
    }

    private static FileStream OpenInstance(string directory)
    {
        try
        {
            return new FileStream(
                Path.Combine(directory, "agent.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new IOException("Backup service is already running.", ex);
        }
    }
}
