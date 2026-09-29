using System.Drawing;
using System.Drawing.Drawing2D;
using DrawingColor = System.Drawing.Color;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;

namespace MyDrive.Backup.App;

public sealed class TrayIcon : IDisposable
{
    private readonly MainWindow _window;
    private readonly System.Windows.Forms.NotifyIcon _icon = new();
    private readonly System.Windows.Forms.ToolStripMenuItem _status;
    private readonly Icon _ownedIcon;

    public TrayIcon(MainWindow window)
    {
        _window = window;
        _ownedIcon = CreateIcon();
        _icon.Icon = _ownedIcon;
        _icon.Visible = true;
        _icon.Text = "My Drive Backup";
        _status = new System.Windows.Forms.ToolStripMenuItem(UiText.Get("heroProtected")) { Enabled = false };
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
        var label = paused
            ? UiText.Get("heroPaused")
            : failed > 0
                ? UiText.Get("failed")
                : active > 0
                    ? UiText.Get("heroUploading")
                    : UiText.Get("heroProtected");
        _status.Text = label;
        var tip = "My Drive Backup — " + label;
        _icon.Text = tip.Length > 63 ? tip[..63] : tip;
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
        _ownedIcon.Dispose();
    }

    private void Show()
    {
        _window.Show();
        _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    private static Icon CreateIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(DrawingColor.Transparent);
            using var ink = new SolidBrush(DrawingColor.FromArgb(15, 118, 110));
            graphics.FillEllipse(ink, 1, 1, 30, 30);
            using var cloud = new SolidBrush(DrawingColor.White);
            graphics.FillEllipse(cloud, 8, 15, 10, 9);
            graphics.FillEllipse(cloud, 13, 11, 12, 11);
            graphics.FillEllipse(cloud, 18, 16, 8, 8);
        }

        var handle = bitmap.GetHicon();
        try
        {
            using var icon = Icon.FromHandle(handle);
            return (Icon)icon.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
