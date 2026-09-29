using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace MyDrive.Backup.App;

public partial class MainWindow : Window
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1.5) };
    private readonly Dictionary<string, (Button Button, IRefresh Page)> _pages = new();
    private readonly SetupView _setup;
    private TrayIcon? _tray;
    private JsonElement _status;
    private string _current = "dashboard";
    private bool _polling;

    public MainWindow()
    {
        InitializeComponent();
        _setup = new SetupView(RefreshNowAsync);
        SetupPage.Content = _setup;
        AddPage("dashboard", UiText.Get("dashboard"), new DashboardView());
        AddPage("backups", UiText.Get("backups"), new BackupsView());
        AddPage("transfers", UiText.Get("transfers"), new TransfersView());
        AddPage("activity", UiText.Get("activity"), new ActivityView());
        AddPage("settings", UiText.Get("settings"), new SettingsView(RefreshNowAsync));
        ShowPage("dashboard");
        _tray = new TrayIcon(this);
        _timer.Tick += async (_, _) => await RefreshNowAsync();
        Loaded += async (_, _) =>
        {
            await ApplyThemeAsync();
            _timer.Start();
            await RefreshNowAsync();
        };
        Closing += (_, args) =>
        {
            if (_tray != null)
            {
                Hide();
                args.Cancel = true;
            }
        };
    }

    public void ExitApplication()
    {
        _timer.Stop();
        _tray?.Dispose();
        _tray = null;
        System.Windows.Application.Current.Shutdown();
    }

    public async Task RefreshNowAsync()
    {
        if (_polling)
        {
            return;
        }

        _polling = true;
        try
        {
            var response = await AgentConnection.CallAsync(new { method = "status" });
            if (!response.GetProperty("ok").GetBoolean())
            {
                return;
            }

            _status = response.GetProperty("result");
            if (_pages.TryGetValue(_current, out var page))
            {
                page.Page.Update(_status);
            }

            var connected = _status.TryGetProperty("server", out var server)
                && server.ValueKind == JsonValueKind.Object
                && Bool(server, "connected");
            SetupHost.Visibility = connected ? Visibility.Collapsed : Visibility.Visible;
            if (!connected)
            {
                _setup.Update(_status);
            }

            _tray?.Update(_status);
            var notes = await AgentConnection.CallAsync(new { method = "notifications.drain" });
            if (notes.GetProperty("ok").GetBoolean() && notes.GetProperty("result").ValueKind == JsonValueKind.Array)
            {
                foreach (var note in notes.GetProperty("result").EnumerateArray())
                {
                    _tray?.Balloon(TextOf(note, "title"), TextOf(note, "body"));
                }
            }
        }
        catch (Exception)
        {
            SetupHost.Visibility = Visibility.Visible;
        }
        finally
        {
            _polling = false;
        }
    }

    public Task BackupNowAsync() => AgentConnection.CallAsync(new { method = "backup.now" });

    public async Task TogglePauseAsync()
    {
        var paused = Bool(_status, "paused");
        await AgentConnection.CallAsync(new { method = paused ? "resumeAll" : "pauseAll" });
        await RefreshNowAsync();
    }

    private void AddPage(string key, string label, IRefresh page)
    {
        var button = new Button
        {
            Content = label,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 4, 0, 0),
            Padding = new Thickness(12, 10, 12, 10),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Foreground = (Brush)FindResource("Text"),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        button.Click += (_, _) => ShowPage(key);
        Navigation.Children.Add(button);
        _pages[key] = (button, page);
    }

    private void ShowPage(string key)
    {
        _current = key;
        foreach (var (name, entry) in _pages)
        {
            entry.Button.FontWeight = name == key ? FontWeights.SemiBold : FontWeights.Normal;
        }

        Pages.Content = _pages[key].Page;
        if (_status.ValueKind == JsonValueKind.Object)
        {
            _pages[key].Page.Update(_status);
        }
    }

    private async Task ApplyThemeAsync()
    {
        var language = "auto";
        var theme = "system";
        try
        {
            var settings = await AgentConnection.CallAsync(new { method = "settings.get" });
            if (settings.GetProperty("ok").GetBoolean())
            {
                language = TextOf(settings.GetProperty("result"), "language");
                theme = TextOf(settings.GetProperty("result"), "theme");
            }
        }
        catch (Exception)
        {
            return;
        }

        UiText.Language = string.IsNullOrEmpty(language) ? "auto" : language;
        var dark = theme == "dark" || (theme != "light" && IsSystemDark());
        SetBrush("Bg", dark ? "#0E141B" : "#F4F7FB");
        SetBrush("Nav", dark ? "#101820" : "#FFFFFF");
        SetBrush("Card", dark ? "#182230" : "#FFFFFF");
        SetBrush("Text", dark ? "#E8EEF6" : "#172033");
        SetBrush("Muted", dark ? "#93A1B5" : "#5C6B82");
        SetBrush("Accent", dark ? "#4C8DFF" : "#2457D6");
        SetBrush("Line", dark ? "#2A3648" : "#E2E8F0");
        Background = (Brush)FindResource("Bg");
    }

    private void SetBrush(string key, string color)
    {
        if (FindResource(key) is SolidColorBrush brush && !brush.IsFrozen)
        {
            brush.Color = (Color)ColorConverter.ConvertFromString(color);
        }
    }

    private static bool IsSystemDark()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        }
        catch (Exception)
        {
            return true;
        }
    }

    internal static string TextOf(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    internal static long LongOf(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) ? number : 0;

    internal static bool Bool(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
}

public interface IRefresh
{
    void Update(JsonElement status);
}
