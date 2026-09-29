using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace MyDrive.Backup.App;

public partial class MainWindow : Window
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly Dictionary<string, (RadioButton Button, IRefresh Page)> _pages = new();
    private readonly Dictionary<string, Func<IRefresh>> _factories = new();
    private SetupView _setup;
    private string _chromeLanguage = "";
    private TrayIcon? _tray;
    private JsonElement _status;
    private string _current = "dashboard";
    private bool _polling;
    private bool _serviceReady;

    public MainWindow()
    {
        InitializeComponent();
        Ui.Report = Report;
        _setup = new SetupView(RefreshNowAsync);
        SetupPage.Content = _setup;
        AddPage("dashboard", "\uE80F");
        AddPage("backups", "\uE8B7");
        AddPage("transfers", "\uE898");
        AddPage("activity", "\uE81C");
        AddPage("settings", "\uE713");
        ShowPage("dashboard");
        _tray = new TrayIcon(this);
        _timer.Tick += async (_, _) => await RefreshNowAsync();
        Loaded += async (_, _) => await StartAsync();
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

    public void ShowServiceProblem(string message)
    {
        _serviceReady = false;
        ServiceBanner.Background = (Brush)FindResource("DangerSoft");
        ServiceBannerTitle.Foreground = (Brush)FindResource("Danger");
        ServiceBannerBody.Foreground = (Brush)FindResource("Danger");
        ServiceBannerTitle.Text = UiText.Get("serviceDown");
        ServiceBannerBody.Text = message;
        ServiceBanner.Visibility = Visibility.Visible;
        SetupHost.Visibility = Visibility.Collapsed;
    }

    public void ShowServiceStarting()
    {
        if (_serviceReady)
        {
            return;
        }

        ServiceBanner.Background = (Brush)FindResource("WarningSoft");
        ServiceBannerTitle.Foreground = (Brush)FindResource("Warning");
        ServiceBannerBody.Foreground = (Brush)FindResource("Warning");
        ServiceBannerTitle.Text = UiText.Get("serviceStarting");
        ServiceBannerBody.Text = UiText.Get("serviceStartingBody");
        ServiceBanner.Visibility = Visibility.Visible;
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
                ShowServiceProblem(TextOf(response, "message"));
                return;
            }

            _serviceReady = true;
            ServiceBanner.Visibility = Visibility.Collapsed;
            _status = response.GetProperty("result");
            if (_pages.TryGetValue(_current, out var page))
            {
                page.Page.Update(_status);
            }

            var server = Object(_status, "server");
            var connected = Bool(server, "connected");
            var email = TextOf(server, "accountEmail");
            var host = TextOf(server, "name");
            SidebarAccount.Text = string.IsNullOrEmpty(email) ? UiText.Get("notSignedIn") : email;
            SidebarServer.Text = string.IsNullOrEmpty(host) ? TextOf(server, "url") : host;
            if (string.IsNullOrEmpty(SidebarServer.Text))
            {
                SidebarServer.Text = UiText.Get("noServer");
            }

            SetupHost.Visibility = connected ? Visibility.Collapsed : Visibility.Visible;
            if (!connected)
            {
                _setup.Update(_status);
            }

            PauseButton.Content = Bool(_status, "paused") ? UiText.Get("resume") : UiText.Get("pause");
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
        catch (Exception ex)
        {
            ShowServiceProblem(ex.Message);
        }
        finally
        {
            _polling = false;
        }
    }

    public async Task BackupNowAsync()
    {
        var response = await Ui.TryCall(new { method = "backup.now" });
        if (response != null)
        {
            await RefreshNowAsync();
        }
    }

    public async Task TogglePauseAsync()
    {
        var paused = Bool(_status, "paused");
        var response = await Ui.TryCall(new { method = paused ? "resumeAll" : "pauseAll" });
        if (response != null)
        {
            await RefreshNowAsync();
        }
    }

    private async Task StartAsync()
    {
        ApplyChrome();
        var theme = ApplyThemeAsync();
        var delay = Task.Delay(600);
        if (await Task.WhenAny(theme, delay) == delay)
        {
            ShowServiceStarting();
        }

        await theme;
        _timer.Start();
        await RefreshNowAsync();
    }

    private async void Pause_Click(object sender, RoutedEventArgs e) => await TogglePauseAsync();

    private async void Backup_Click(object sender, RoutedEventArgs e) => await BackupNowAsync();

    private async void Retry_Click(object sender, RoutedEventArgs e)
    {
        ShowServiceStarting();
        await RefreshNowAsync();
    }

    private void Report(Exception exception)
    {
        if (exception is BackupServiceUnavailableException unavailable)
        {
            ShowServiceProblem(unavailable.Message);
            return;
        }

        MessageBox.Show(exception.Message, "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void AddPage(string key, string icon)
    {
        var button = new RadioButton
        {
            Content = UiText.Get(key),
            Tag = icon,
            Style = (Style)FindResource("NavButton"),
        };
        button.Checked += (_, _) => ShowPage(key);
        Navigation.Children.Add(button);
        _factories[key] = key switch
        {
            "backups" => () => new BackupsView(),
            "transfers" => () => new TransfersView(),
            "activity" => () => new ActivityView(),
            "settings" => () => new SettingsView(AfterSettingsAsync),
            _ => () => new DashboardView(),
        };
        _pages[key] = (button, _factories[key]());
    }

    private void RebuildPages()
    {
        foreach (var key in _factories.Keys)
        {
            var button = _pages[key].Button;
            _pages[key] = (button, _factories[key]());
        }

        _setup = new SetupView(RefreshNowAsync);
        SetupPage.Content = _setup;
        if (_pages.TryGetValue(_current, out var current))
        {
            Pages.Content = current.Page;
        }
    }

    private void ShowPage(string key)
    {
        if (!_pages.ContainsKey(key))
        {
            return;
        }

        _current = key;
        foreach (var (name, entry) in _pages)
        {
            if (name == key && entry.Button.IsChecked != true)
            {
                entry.Button.IsChecked = true;
            }
        }

        PageTitle.Text = UiText.Get(key);
        PageSubtitle.Text = UiText.Get("subtitle" + char.ToUpperInvariant(key[0]) + key[1..]);
        Pages.Content = _pages[key].Page;
        if (_status.ValueKind == JsonValueKind.Object)
        {
            _pages[key].Page.Update(_status);
        }
    }

    private async Task AfterSettingsAsync()
    {
        await ApplyThemeAsync();
        ApplyChrome();
        await RefreshNowAsync();
    }

    private void ApplyChrome()
    {
        if (_chromeLanguage != UiText.Language)
        {
            var first = _chromeLanguage.Length == 0;
            _chromeLanguage = UiText.Language;
            if (!first)
            {
                RebuildPages();
            }
        }

        foreach (var (key, entry) in _pages)
        {
            entry.Button.Content = UiText.Get(key);
        }

        BackupButton.Content = UiText.Get("backupNow");
        PauseButton.Content = Bool(_status, "paused") ? UiText.Get("resume") : UiText.Get("pause");
        RetryServiceButton.Content = UiText.Get("retry");
        NavSubtitle.Text = UiText.Get("ready");
        if (_pages.ContainsKey(_current))
        {
            PageTitle.Text = UiText.Get(_current);
            PageSubtitle.Text = UiText.Get("subtitle" + char.ToUpperInvariant(_current[0]) + _current[1..]);
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
        catch (Exception ex) when (ex is BackupServiceUnavailableException or TimeoutException or IOException or InvalidOperationException)
        {
            return;
        }

        UiText.Language = string.IsNullOrEmpty(language) ? "auto" : language;
        var dark = theme == "dark" || (theme != "light" && IsSystemDark());
        SetBrush("Bg", dark ? "#0E141B" : "#F6F4EF");
        SetBrush("Nav", dark ? "#0B1016" : "#1B2430");
        SetBrush("Card", dark ? "#17202B" : "#FFFFFF");
        SetBrush("Text", dark ? "#F4F1EA" : "#1C2430");
        SetBrush("Muted", dark ? "#9AA6B2" : "#667085");
        SetBrush("Accent", dark ? "#2DD4BF" : "#0F766E");
        SetBrush("AccentSoft", dark ? "#134E4A" : "#CCFBF1");
        SetBrush("Line", dark ? "#2A3544" : "#E7E2D8");
        SetBrush("Danger", dark ? "#F97066" : "#B42318");
        SetBrush("DangerSoft", dark ? "#3F1D1D" : "#FEF3F2");
        SetBrush("Ok", dark ? "#32D583" : "#067647");
        SetBrush("OkSoft", dark ? "#12382C" : "#E7F6EE");
        SetBrush("Warning", dark ? "#FDB022" : "#B54708");
        SetBrush("WarningSoft", dark ? "#3B2A12" : "#FEF4E6");
        SetBrush("Input", dark ? "#121A24" : "#FFFFFF");
        SetBrush("SidebarText", "#F8FAFC");
        SetBrush("SidebarMuted", "#94A3B8");
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

    internal static JsonElement Object(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;
}

public interface IRefresh
{
    void Update(JsonElement status);
}
