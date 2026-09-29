using System.Windows;

namespace MyDrive.Backup.App;

public partial class App : Application
{
    public App()
    {
        System.Windows.Forms.Application.SetHighDpiMode(System.Windows.Forms.HighDpiMode.PerMonitorV2);
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show(args.Exception.Message, "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };
        foreach (var key in new[] { "Bg", "Nav", "Card", "Text", "Muted", "Accent", "Line", "Danger", "Ok" })
        {
            if (Resources[key] is System.Windows.Media.SolidColorBrush brush)
            {
                Resources[key] = brush.Clone();
            }
        }

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }
}
