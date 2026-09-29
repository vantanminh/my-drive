namespace MyDrive.Backup;

public static class ClientInfo
{
    public static string Version { get; } = FormatVersion(typeof(ClientInfo).Assembly.GetName().Version);

    public const string ApiVersion = "1";
    public const string Name = "Windows Backup Client";
    public const string PipeName = "MyDrive.Backup";
    public const string UpdateRepository = "vantanminh/my-drive";
    public const string ReleaseTagPrefix = "windows-client-v";
    public const string InstallerFileName = "MyDriveBackup-Setup.exe";

    public static string DataDirectory { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MyDriveBackup");

    public static string FormatVersion(Version? version)
    {
        if (version == null)
        {
            return "0.0.0";
        }

        var patch = version.Build < 0 ? 0 : version.Build;
        return $"{version.Major}.{version.Minor}.{patch}";
    }
}
