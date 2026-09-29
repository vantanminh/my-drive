using System.Diagnostics;
using static MyDrive.Backup.App.Ui;
using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using MyDrive.Backup;

namespace MyDrive.Backup.App;

public sealed class DashboardView : StackPanel, IRefresh
{
    private readonly TextBlock _account = Body();
    private readonly TextBlock _storage = Body();
    private readonly TextBlock _overview = Body();
    private readonly TextBlock _activity = Body();

    public DashboardView()
    {
        Children.Add(Title(UiText.Get("dashboard")));
        Children.Add(Card(UiText.Get("account"), _account));
        Children.Add(Card(UiText.Get("storage"), _storage));
        Children.Add(Card(UiText.Get("protected"), _overview));
        Children.Add(Card(UiText.Get("uploading"), _activity));
    }

    public void Update(JsonElement status)
    {
        var server = Object(status, "server");
        var storage = Object(status, "storage");
        var overview = Object(status, "overview");
        var email = MainWindow.TextOf(server, "accountEmail");
        var host = MainWindow.TextOf(server, "name");
        _account.Text = $"Account: {(string.IsNullOrEmpty(email) ? "—" : email)}\nServer: {(string.IsNullOrEmpty(host) ? "—" : host)}";
        if (storage.ValueKind != JsonValueKind.Object)
        {
            _storage.Text = "Storage quota: —";
        }
        else if (MainWindow.Bool(storage, "unlimited"))
        {
            _storage.Text = $"Storage quota: {UiText.Get("unlimited")}\nUsed: {ByteFormat.Format(MainWindow.LongOf(storage, "usedBytes"))}";
        }
        else
        {
            var used = MainWindow.LongOf(storage, "usedBytes");
            var quota = MainWindow.LongOf(storage, "quotaBytes");
            var percent = storage.TryGetProperty("percentUsed", out var value) && value.TryGetDouble(out var number) ? number : 0;
            _storage.Text = $"Storage:\n{ByteFormat.Format(used)} / {ByteFormat.Format(quota)}\n\n{percent:0}% used";
        }

        var last = MainWindow.TextOf(overview, "lastBackupAt");
        _overview.Text =
            $"Protected folders: {MainWindow.LongOf(overview, "protectedFolders")}\n\nFiles backed up: {MainWindow.LongOf(overview, "filesBackedUp"):N0}\n\nBackup size:\n{ByteFormat.Format(MainWindow.LongOf(overview, "backupBytes"))}\n\nLast backup:\n{(string.IsNullOrEmpty(last) ? "—" : last)}";
        var speed = status.TryGetProperty("bytesPerSecond", out var rate) && rate.TryGetDouble(out var perSecond) ? perSecond : 0;
        var remaining = MainWindow.LongOf(status, "remainingBytes");
        _activity.Text =
            $"Uploading: {MainWindow.LongOf(status, "activeUploads")} files\n\nSpeed:\n{ByteFormat.FormatSpeed(speed)}\n\nRemaining:\n{ByteFormat.Format(remaining)}\n\nEstimated time:\n{ByteFormat.FormatEta(remaining, speed)}";
    }

    private static JsonElement Object(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) ? value : default;
}

public sealed class BackupsView : DockPanel, IRefresh
{
    private readonly StackPanel _jobs = new();

    public BackupsView()
    {
        var bar = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 16) };
        bar.Children.Add(Title(UiText.Get("backups")));
        var add = UiButton(UiText.Get("addFolder"));
        add.Margin = new Thickness(16, 0, 0, 0);
        add.Click += async (_, _) => await AddJobAsync();
        bar.Children.Add(add);
        Children.Add(bar);
        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = _jobs };
        Children.Add(scroll);
        LastChildFill = true;
    }

    public void Update(JsonElement status)
    {
        _jobs.Children.Clear();
        if (!status.TryGetProperty("jobs", out var jobs) || jobs.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var job in jobs.EnumerateArray())
        {
            var id = MainWindow.TextOf(job, "id");
            var paused = MainWindow.Bool(job, "paused");
            var block = new StackPanel();
            block.Children.Add(Body($"{MainWindow.TextOf(job, "name")}          {(paused ? "Paused" : "Running")}"));
            block.Children.Add(Muted($"{MainWindow.TextOf(job, "sourcePath")}\n{MainWindow.TextOf(job, "destination")}\n{MainWindow.TextOf(job, "mode")}"));
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
            var now = UiButton(UiText.Get("backupNow"));
            now.Click += async (_, _) => await AgentConnection.CallAsync(new { method = "backup.now", id });
            var pause = UiButton(paused ? UiText.Get("resume") : UiText.Get("pause"));
            pause.Click += async (_, _) => await AgentConnection.CallAsync(new { method = paused ? "resume" : "pause", id });
            var remove = UiButton("Remove");
            remove.Click += async (_, _) =>
            {
                if (System.Windows.MessageBox.Show("Removing a backup job does not delete files already stored on the server.", "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
                {
                    return;
                }

                await AgentConnection.CallAsync(new { method = "jobs.delete", id, confirm = true });
            };
            row.Children.Add(now);
            row.Children.Add(pause);
            row.Children.Add(remove);
            block.Children.Add(row);
            _jobs.Children.Add(Card(block));
        }
    }

    private static async Task AddJobAsync()
    {
        using var dialog = new System.Windows.Forms.FolderBrowserDialog { Description = UiText.Get("choose") };
        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK)
        {
            return;
        }

        var name = new System.IO.DirectoryInfo(dialog.SelectedPath).Name;
        var destination = "Backups/" + Environment.MachineName + "/" + name;
        await AgentConnection.CallAsync(new
        {
            method = "jobs.upsert",
            job = new
            {
                name,
                sourcePath = dialog.SelectedPath,
                destination,
                mode = "continuous",
                deletionPolicy = "keep",
            },
        });
    }
}

public sealed class TransfersView : DockPanel, IRefresh
{
    private readonly TextBlock _summary = Body();
    private readonly StackPanel _rows = new();
    private readonly System.Windows.Shapes.Polyline _chart = new() { StrokeThickness = 2 };

    public TransfersView()
    {
        Children.Add(Title(UiText.Get("transfers")));
        Children.Add(_summary);
        _chart.Stroke = Brushes.DodgerBlue;
        var canvas = new Canvas { Height = 80, Margin = new Thickness(0, 8, 0, 12) };
        canvas.Children.Add(_chart);
        canvas.SizeChanged += (_, _) => Draw(canvas, _lastSpeeds);
        Children.Add(canvas);
        Children.Add(new ScrollViewer { Content = _rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        LastChildFill = true;
    }

    private double[] _lastSpeeds = [];

    public void Update(JsonElement status)
    {
        var speed = status.TryGetProperty("bytesPerSecond", out var rate) && rate.TryGetDouble(out var perSecond) ? perSecond : 0;
        _summary.Text =
            $"Upload speed: {ByteFormat.FormatSpeed(speed)}\nCurrent uploads: {MainWindow.LongOf(status, "activeUploads")}\nQueue size: {MainWindow.LongOf(status, "queueSize")}\nUploaded data: {ByteFormat.Format(MainWindow.LongOf(status, "sessionUploadedBytes"))}\nRemaining data: {ByteFormat.Format(MainWindow.LongOf(status, "remainingBytes"))}\nWorkers: {MainWindow.LongOf(status, "workers")}\nNetwork: {MainWindow.TextOf(status, "networkStatus")}\nFailed uploads: {MainWindow.LongOf(status, "failed")}\nRetrying: {MainWindow.LongOf(status, "retrying")}";
        _rows.Children.Clear();
        if (status.TryGetProperty("transfers", out var transfers) && transfers.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in transfers.EnumerateArray())
            {
                var size = MainWindow.LongOf(item, "fileSize");
                var sent = MainWindow.LongOf(item, "bytesSent");
                var percent = size <= 0 ? 0 : sent * 100 / size;
                var line = $"{MainWindow.TextOf(item, "relativePath")}      {MainWindow.TextOf(item, "state")}";
                if (MainWindow.TextOf(item, "state") == "Uploading" && size > 0)
                {
                    line += $"\n{ByteFormat.Format(sent)} / {ByteFormat.Format(size)}\n{percent}%\n{ByteFormat.FormatSpeed(speed)}\nETA: {ByteFormat.FormatEta(size - sent, speed)}";
                }

                if (!string.IsNullOrEmpty(MainWindow.TextOf(item, "error")))
                {
                    line += "\n" + MainWindow.TextOf(item, "error");
                }

                _rows.Children.Add(Body(line));
            }
        }

        if (status.TryGetProperty("speedHistory", out var history) && history.ValueKind == JsonValueKind.Array)
        {
            _lastSpeeds = history.EnumerateArray().Select(item => item.TryGetDouble(out var number) ? number : 0).ToArray();
        }
    }

    private void Draw(Canvas canvas, double[] speeds)
    {
        _chart.Points.Clear();
        if (speeds.Length == 0 || canvas.ActualWidth <= 0)
        {
            return;
        }

        var max = Math.Max(1, speeds.Max());
        for (var i = 0; i < speeds.Length; i++)
        {
            var x = canvas.ActualWidth * i / Math.Max(1, speeds.Length - 1);
            var y = canvas.ActualHeight - (speeds[i] / max * (canvas.ActualHeight - 4));
            _chart.Points.Add(new System.Windows.Point(x, y));
        }
    }
}

public sealed class ActivityView : DockPanel, IRefresh
{
    private readonly StackPanel _rows = new();
    private string _filter = "All";

    public ActivityView()
    {
        var filters = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12) };
        foreach (var filter in new[] { "All", "Uploaded", "Skipped", "Failed", "Deleted" })
        {
            var button = UiButton(UiText.Get(filter.ToLowerInvariant()));
            var selected = filter;
            button.Click += async (_, _) =>
            {
                _filter = selected;
                await ReloadAsync();
            };
            filters.Children.Add(button);
        }

        Children.Add(Title(UiText.Get("activity")));
        Children.Add(filters);
        Children.Add(new ScrollViewer { Content = _rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        LastChildFill = true;
    }

    public void Update(JsonElement status) => _ = ReloadAsync();

    private async Task ReloadAsync()
    {
        var response = await AgentConnection.CallAsync(new { method = "activity", filter = _filter });
        _rows.Children.Clear();
        if (!response.GetProperty("ok").GetBoolean())
        {
            return;
        }

        foreach (var entry in response.GetProperty("result").EnumerateArray())
        {
            var reason = MainWindow.TextOf(entry, "reason");
            _rows.Children.Add(Body($"{MainWindow.TextOf(entry, "at")}\n{MainWindow.TextOf(entry, "kind")}\n{MainWindow.TextOf(entry, "path")}" + (string.IsNullOrEmpty(reason) ? "" : $"\nReason: {reason}")));
        }
    }
}

public sealed class SettingsView : StackPanel, IRefresh
{
    private readonly Action _refresh;
    private JsonElement _settings;
    private JsonElement _status;

    public SettingsView(Func<Task> refresh)
    {
        _refresh = () => _ = refresh();
        Children.Add(Title(UiText.Get("settings")));
    }

    public void Update(JsonElement status)
    {
        _status = status;
        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        var response = await AgentConnection.CallAsync(new { method = "settings.get" });
        if (!response.GetProperty("ok").GetBoolean())
        {
            return;
        }

        _settings = response.GetProperty("result");
        Children.Clear();
        Children.Add(Title(UiText.Get("settings")));
        var server = _status.ValueKind == JsonValueKind.Object && _status.TryGetProperty("server", out var value) ? value : default;
        Children.Add(Section("Account",
            $"Account: {MainWindow.TextOf(server, "accountEmail")}\nServer URL: {MainWindow.TextOf(server, "url")}\nServer name: {MainWindow.TextOf(server, "name")}\nConnection: {(MainWindow.Bool(server, "connected") ? "Connected" : "Disconnected")}\nAPI version: {MainWindow.TextOf(server, "apiVersion")}\nDevice: {MainWindow.TextOf(server, "deviceId")}"));
        var serverBox = new TextBox { Text = MainWindow.TextOf(server, "url"), Margin = new Thickness(0, 8, 0, 8) };
        var insecure = new CheckBox { Content = UiText.Get("insecure") + " — HTTP is only for a development or LAN server", IsChecked = MainWindow.Bool(server, "allowInsecure") };
        var actions = new StackPanel { Orientation = Orientation.Horizontal };
        actions.Children.Add(ActionButton(UiText.Get("test"), async () => Show(await AgentConnection.CallAsync(new { method = "server.test", url = serverBox.Text, allowInsecure = insecure.IsChecked == true }))));
        actions.Children.Add(ActionButton(UiText.Get("changeServer"), async () =>
        {
            if (System.Windows.MessageBox.Show("Changing the server pauses backup jobs for the current server. Account, backup jobs, and data for that server may not apply to the new server.", "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            {
                return;
            }

            Show(await AgentConnection.CallAsync(new { method = "server.set", url = serverBox.Text, allowInsecure = insecure.IsChecked == true, confirm = true }));
        }));
        actions.Children.Add(ActionButton(UiText.Get("disconnect"), async () =>
        {
            if (System.Windows.MessageBox.Show("Disconnect this device from the server? Cloud files stay on the server.", "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            {
                return;
            }

            Show(await AgentConnection.CallAsync(new { method = "auth.logout", confirm = true }));
        }));
        Children.Add(serverBox);
        Children.Add(insecure);
        Children.Add(actions);

        Children.Add(Section("Backup", "Default destination, schedule, and deletion policy. Removing a job keeps the cloud copy."));
        Children.Add(Editor("Default destination", "defaultDestination"));
        Children.Add(Choice("Deletion policy", "deletionPolicy", ["keep", "trash", "delay"]));
        Children.Add(Section("Filters", "Included extensions, excluded extensions, excluded folders, glob patterns, and size limits are stored on each backup job. System files and symbolic links stay off unless you enable them here."));
        Children.Add(Check("Backup hidden files", "backupHiddenFiles"));
        Children.Add(Check("Backup Windows system files", "backupSystemFiles"));
        Children.Add(Check("Follow symbolic links", "followSymlinks"));
        Children.Add(Section("Transfer", "Concurrent uploads, chunk size, speed limit, and retries."));
        Children.Add(Choice("Concurrent uploads", "concurrentUploads", ["1", "2", "3", "4", "5", "8"]));
        Children.Add(Choice("Chunk size", "chunkSizeMb", ["8", "16", "32", "64"]));
        Children.Add(Choice("Upload limit", "uploadLimitBytesPerSecond", ["", "10485760", "20971520", "52428800"]));
        Children.Add(Section("Network", "Backup does not use a metered connection unless you allow it. An unknown metered state does not block backup."));
        Children.Add(Check("Backup on Wi-Fi", "backupOnWifi"));
        Children.Add(Check("Backup on Ethernet", "backupOnEthernet"));
        Children.Add(Check("Backup on metered network", "backupOnMetered"));
        Children.Add(Section("Application", "The backup service keeps running after this window closes."));
        Children.Add(Check("Start backup service with Windows", "startWithWindows"));
        Children.Add(Check("Run in background", "runInBackground"));
        Children.Add(Check("Notifications", "notifications"));
        Children.Add(Choice("Language", "language", ["auto", "en", "vi"]));
        Children.Add(Choice("Theme", "theme", ["system", "light", "dark"]));
        Children.Add(Section("Advanced", "The local database does not store access tokens. Rebuild and verify never delete cloud data."));
        var advanced = new StackPanel { Orientation = Orientation.Horizontal };
        advanced.Children.Add(ActionButton("Open logs", async () =>
        {
            var logs = await AgentConnection.CallAsync(new { method = "logs.list" });
            var text = logs.GetProperty("ok").GetBoolean()
                ? string.Join("\n", logs.GetProperty("result").EnumerateArray().Select(entry => $"{MainWindow.TextOf(entry, "at")} {MainWindow.TextOf(entry, "level")} {MainWindow.TextOf(entry, "message")}"))
                : MainWindow.TextOf(logs, "message");
            System.Windows.MessageBox.Show(string.IsNullOrEmpty(text) ? "No log entries." : text, "Logs");
        }));
        advanced.Children.Add(ActionButton("Export logs", async () =>
        {
            var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "mydrive-backup.log", Filter = "Log|*.log" };
            if (dialog.ShowDialog() != true)
            {
                return;
            }

            var exported = await AgentConnection.CallAsync(new { method = "logs.export" });
            await File.WriteAllTextAsync(dialog.FileName, exported.GetProperty("result").GetProperty("text").GetString() ?? "");
        }));
        advanced.Children.Add(ActionButton("Clear logs", async () =>
        {
            if (Confirm("Clear the local troubleshooting log?"))
            {
                Show(await AgentConnection.CallAsync(new { method = "logs.clear", confirm = true }));
            }
        }));
        advanced.Children.Add(ActionButton("Rebuild local index", async () =>
        {
            if (Confirm("Rebuilding the local index does not delete cloud backups. The next scan compares files again."))
            {
                Show(await AgentConnection.CallAsync(new { method = "index.rebuild", confirm = true }));
            }
        }));
        advanced.Children.Add(ActionButton("Verify backup integrity", async () =>
        {
            if (Confirm("This re-reads local files and compares checksums. It does not delete cloud data."))
            {
                Show(await AgentConnection.CallAsync(new { method = "integrity.verify", confirm = true }));
            }
        }));
        Children.Add(advanced);
        var save = UiButton("Save settings");
        save.Margin = new Thickness(0, 16, 0, 0);
        save.Click += async (_, _) =>
        {
            Show(await AgentConnection.CallAsync(new { method = "settings.set", settings = JsonSerializer.Deserialize<JsonElement>(_settings.GetRawText()) }));
            _refresh();
        };
        Children.Add(save);
    }

    private FrameworkElement Editor(string label, string property)
    {
        var box = new TextBox { Text = MainWindow.TextOf(_settings, property), Margin = new Thickness(0, 4, 0, 8) };
        box.TextChanged += (_, _) => _settings = Replace(_settings, property, box.Text);
        return Labeled(label, box);
    }

    private FrameworkElement Choice(string label, string property, string[] options)
    {
        var box = new ComboBox { Margin = new Thickness(0, 4, 0, 8) };
        foreach (var option in options)
        {
            box.Items.Add(string.IsNullOrEmpty(option) ? "Unlimited" : option);
        }

        var current = _settings.TryGetProperty(property, out var value) ? value.ToString() : "";
        box.SelectedItem = string.IsNullOrEmpty(current) ? "Unlimited" : current;
            box.SelectionChanged += (_, _) =>
            {
                var selected = box.SelectedItem as string ?? "";
                _settings = Replace(_settings, property, selected == "Unlimited" ? null : selected);
            };
        return Labeled(label, box);
    }

    private CheckBox Check(string label, string property)
    {
        var box = new CheckBox { Content = label, IsChecked = MainWindow.Bool(_settings, property), Margin = new Thickness(0, 4, 0, 4) };
        box.Checked += (_, _) => _settings = Replace(_settings, property, true);
        box.Unchecked += (_, _) => _settings = Replace(_settings, property, false);
        return box;
    }

    private static JsonElement Replace(JsonElement element, string property, object? value)
    {
        var map = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(element.GetRawText()) ?? new Dictionary<string, JsonElement>();
        map[property] = value is null
            ? JsonDocument.Parse("null").RootElement.Clone()
            : JsonSerializer.SerializeToElement(value);
        return JsonSerializer.SerializeToElement(map);
    }

    private void Show(JsonElement response)
    {
        if (!response.GetProperty("ok").GetBoolean())
        {
            System.Windows.MessageBox.Show(MainWindow.TextOf(response, "message"), "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        _refresh();
    }

    private static bool Confirm(string message) =>
        System.Windows.MessageBox.Show(message, "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) == MessageBoxResult.OK;
}

public sealed class SetupView : StackPanel, IRefresh
{
    private readonly TextBox _url = new() { Text = "https://", Margin = new Thickness(0, 8, 0, 8) };
    private readonly CheckBox _insecure = new() { Content = "Allow insecure HTTP for a development or LAN server" };
    private readonly TextBlock _detail = Body();
    private int _step;

    public SetupView(Func<Task> refresh)
    {
        Children.Add(Title(UiText.Get("connect")));
        Children.Add(new TextBlock { Text = "Server URL", Foreground = Brushes.Gray });
        Children.Add(_url);
        Children.Add(_insecure);
        var test = UiButton(UiText.Get("test"));
        test.Click += async (_, _) => await TestAsync();
        var browser = UiButton(UiText.Get("signIn"));
        browser.Click += async (_, _) => await AuthorizeAsync();
        var next = UiButton(UiText.Get("start"));
        next.Click += async (_, _) =>
        {
            await AgentConnection.CallAsync(new { method = "backup.now" });
            await refresh();
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(test);
        row.Children.Add(browser);
        row.Children.Add(next);
        Children.Add(row);
        Children.Add(_detail);
    }

    public void Update(JsonElement status)
    {
        var state = MainWindow.TextOf(status, "authState");
        var detail = MainWindow.TextOf(status, "authDetail");
        var code = MainWindow.TextOf(status, "authUserCode");
        if (state is "pending" or "authorized" or "denied" or "expired" or "error")
        {
            _step = 2;
        }

        if (state == "pending")
        {
            var waiting = UiText.Get("waitingApproval");
            _detail.Text = string.IsNullOrEmpty(code) ? waiting : UiText.Get("userCode") + " " + code + "\n" + waiting;
            return;
        }

        if (state == "authorized")
        {
            _detail.Text = string.IsNullOrEmpty(detail) ? UiText.Get("authorized") : UiText.Get("authorized") + "\n" + detail;
            return;
        }

        if (state is "denied" or "expired" or "error")
        {
            _detail.Text = string.IsNullOrEmpty(detail) ? state : detail;
            return;
        }

        _detail.Text = _step switch
        {
            0 => "Enter the URL of your own server. Nothing is built in.",
            _ => string.IsNullOrEmpty(detail) ? "Continue in the browser and choose Authorize Windows Backup Client." : detail,
        };
    }

    private async Task TestAsync()
    {
        var response = await AgentConnection.CallAsync(new { method = "server.test", url = _url.Text, allowInsecure = _insecure.IsChecked == true });
        if (!response.GetProperty("ok").GetBoolean())
        {
            _detail.Text = MainWindow.TextOf(response, "message");
            return;
        }

        var result = response.GetProperty("result");
        _detail.Text = $"Connected to {MainWindow.TextOf(result, "name")}\nAPI {MainWindow.TextOf(result, "apiVersion")} · server {MainWindow.TextOf(result, "serverVersion")}";
        if (_url.Text.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            _detail.Text = UiText.Get("insecure") + "\n" + _detail.Text;
        }

        _step = 1;
    }

    private async Task AuthorizeAsync()
    {
        var saved = await AgentConnection.CallAsync(new { method = "server.set", url = _url.Text, allowInsecure = _insecure.IsChecked == true, confirm = true });
        if (!saved.GetProperty("ok").GetBoolean())
        {
            _detail.Text = MainWindow.TextOf(saved, "message");
            return;
        }

        var began = await AgentConnection.CallAsync(new { method = "auth.begin" });
        if (!began.GetProperty("ok").GetBoolean())
        {
            _detail.Text = MainWindow.TextOf(began, "message");
            return;
        }

        var uri = MainWindow.TextOf(began.GetProperty("result"), "verificationUri");
        if (!string.IsNullOrWhiteSpace(uri))
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }

        _detail.Text = "User code " + MainWindow.TextOf(began.GetProperty("result"), "userCode") + "\nApprove this device in the browser. Backup starts after authorization.";
        _step = 2;
    }
}

internal static class Ui
{
    public static TextBlock Title(string text) => new()
    {
        Text = text,
        FontSize = 28,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 0, 0, 16),
        Foreground = Brush("Text"),
    };

    public static TextBlock Body(string text = "") => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 0, 0, 8),
        Foreground = Brush("Text"),
    };

    public static TextBlock Muted(string text) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        Foreground = Brush("Muted"),
    };

    public static Border Card(string title, TextBlock body)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, Foreground = Brush("Muted"), Margin = new Thickness(0, 0, 0, 8) });
        stack.Children.Add(body);
        return Card(stack);
    }

    public static Border Card(UIElement child) => new()
    {
        Background = Brush("Card"),
        BorderBrush = Brush("Line"),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(12),
        Padding = new Thickness(16),
        Margin = new Thickness(0, 0, 0, 12),
        Child = child,
    };

    public static Border Section(string title, string body) => Card(title, Body(body));

    public static Button UiButton(string text) => new()
    {
        Content = text,
        Margin = new Thickness(0, 0, 8, 0),
        Padding = new Thickness(12, 8, 12, 8),
        Background = Brush("Accent"),
        Foreground = Brushes.White,
        BorderThickness = new Thickness(0),
        Cursor = System.Windows.Input.Cursors.Hand,
    };

    public static Button ActionButton(string text, Func<Task> action)
    {
        var button = UiButton(text);
        button.Click += async (_, _) =>
        {
            try
            {
                await action();
            }
            catch (Exception ex)
            {
                System.Windows.MessageBox.Show(ex.Message, "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        };
        return button;
    }

    public static StackPanel Labeled(string label, UIElement child)
    {
        var stack = new StackPanel();
        stack.Children.Add(Muted(label));
        stack.Children.Add(child);
        return stack;
    }

    private static Brush Brush(string key) =>
        System.Windows.Application.Current.TryFindResource(key) as Brush ?? System.Windows.Media.Brushes.White;
}
