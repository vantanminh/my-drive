using System.Diagnostics;
using MyDrive.Backup;

namespace MyDrive.Backup.Agent;

internal static class WindowsStartup
{
    private const string RunName = "MyDriveBackup";

    public static void Apply(ClientSettings settings) => Apply(settings.StartWithWindows);

    public static void Apply(bool enabled)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            if (key == null)
            {
                return;
            }

            if (!enabled)
            {
                key.DeleteValue(RunName, throwOnMissingValue: false);
                return;
            }

            var executable = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable))
            {
                return;
            }

            key.SetValue(RunName, $"\"{executable}\"");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            Console.Error.WriteLine("Could not update the Windows startup setting.");
        }
    }

    public static int TryInstallService()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("The Windows service can only be installed on Windows.");
            return 1;
        }

        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
        {
            return 1;
        }

        try
        {
            var create = Process.Start(new ProcessStartInfo("sc.exe", $"create MyDriveBackup binPath= \"{executable}\" start= auto")
            {
                UseShellExecute = false,
            });
            create?.WaitForExit();
            Console.WriteLine(create?.ExitCode == 0
                ? "Service registered. The tray app and the service share one pipe, so only one instance runs."
                : "Service registration did not complete. Start with Windows still uses the current user Run key.");
            return create?.ExitCode ?? 1;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Console.Error.WriteLine("Could not start sc.exe. The per-user startup entry is still available.");
            return 1;
        }
    }
}
