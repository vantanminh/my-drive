using System.Windows;
using System.Windows.Media;

namespace MyDrive.Backup.App;

public partial class App : Application
{
    private DateTime _lastDialogUtc = DateTime.MinValue;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            if (args.Exception is BackupServiceUnavailableException unavailable && MainWindow is MainWindow window)
            {
                window.ShowServiceProblem(unavailable.Message);
                args.Handled = true;
                return;
            }

            if (DateTime.UtcNow - _lastDialogUtc < TimeSpan.FromSeconds(8))
            {
                args.Handled = true;
                return;
            }

            _lastDialogUtc = DateTime.UtcNow;
            MessageBox.Show(args.Exception.Message, "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };

        var keys = new List<object>();
        foreach (var key in Resources.Keys)
        {
            keys.Add(key);
        }

        foreach (var key in keys)
        {
            if (Resources[key] is SolidColorBrush { IsFrozen: true } brush)
            {
                Resources[key] = brush.Clone();
            }
        }

        var main = new MainWindow();
        MainWindow = main;
        main.Show();
    }
}
