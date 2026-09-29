using System.Drawing;
using System.Text.Json;
using System.Windows;

namespace MyDrive.Backup.App;

public sealed class TrayIcon : IDisposable
{
    private readonly MainWindow _window;
    private readonly System.Windows.Forms.NotifyIcon _icon = new();
    private readonly System.Windows.Forms.ToolStripMenuItem _status;

    public TrayIcon(MainWindow window)
    {
        _window = window;
        _icon.Icon = SystemIcons.Shield;
        _icon.Visible = true;
        _icon.Text = "My Drive Backup";
        _status = new System.Windows.Forms.ToolStripMenuItem("Idle") { Enabled = false };
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add(UiText.Get("open"), null, (_, _) => Show());
        menu.Items.Add(UiText.Get("backupNow"), null, async (_, _) => await window.BackupNowAsync());
        menu.Items.Add(UiText.Get("pause"), null, async (_, _) => await window.TogglePauseAsync());
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add(_status);
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add(UiText.Get("settings"), null, (_, _) => Show());
        menu.Items.Add(UiText.Get("exit"), null, (_, _) => window.ExitApplication());
        _icon.ContextMenuStrip = menu;
        _icon.DoubleClick += (_, _) => Show();
    }

    public void Update(JsonElement status)
    {
        var paused = MainWindow.Bool(status, "paused");
        var active = MainWindow.LongOf(status, "activeUploads");
        var failed = MainWindow.LongOf(status, "failed");
        var label = paused ? "Paused" : failed > 0 ? "Error" : active > 0 ? $"Uploading {active} files" : "Idle";
        _status.Text = "Current: " + label;
        _icon.Text = "My Drive Backup — " + label;
    }

    public void Balloon(string title, string body)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return;
        }

        _icon.ShowBalloonTip(6000, title, body, System.Windows.Forms.ToolTipIcon.Info);
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }

    private void Show()
    {
        _window.Show();
        _window.WindowState = WindowState.Normal;
        _window.Activate();
    }
}
