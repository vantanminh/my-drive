namespace MyDrive.Backup;

public static class ClientInfo
{
    public const string Version = "1.0.0";
    public const string ApiVersion = "1";
    public const string Name = "Windows Backup Client";
    public const string PipeName = "MyDrive.Backup";

    public static string DataDirectory { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MyDriveBackup");
}
