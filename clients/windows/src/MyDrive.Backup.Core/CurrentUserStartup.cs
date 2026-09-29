namespace MyDrive.Backup;

public static class CurrentUserStartup
{
    private const string RunName = "MyDriveBackup";

    public static void Apply(bool enabled, string? executable = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run",
                writable: true);
            if (key == null)
            {
                return;
            }

            if (!enabled)
            {
                key.DeleteValue(RunName, throwOnMissingValue: false);
                return;
            }

            executable = string.IsNullOrWhiteSpace(executable) ? Environment.ProcessPath : executable;
            if (string.IsNullOrWhiteSpace(executable))
            {
                return;
            }

            key.SetValue(RunName, $"\"{executable}\"");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
        }
    }
}
