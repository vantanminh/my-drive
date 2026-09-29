using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Shapes;
using MyDrive.Backup;

namespace MyDrive.Backup.App;

public sealed class DashboardView : StackPanel, IRefresh
{
    private readonly Border _hero = CardHost();
    private readonly TextBlock _pill = new() { FontSize = 12, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock _heroTitle = new() { FontSize = 26, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 14, 0, 0), TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock _heroBody = new() { FontSize = 14, Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock _folders = MetricValue();
    private readonly TextBlock _files = MetricValue();
    private readonly TextBlock _size = MetricValue();
    private readonly TextBlock _last = MetricValue();
    private readonly TextBlock _storage = Body();
    private readonly ProgressBar _meter = new() { Margin = new Thickness(0, 12, 0, 0) };
    private readonly TextBlock _activity = Body();

    public DashboardView()
    {
        var pillHost = new Border { CornerRadius = new CornerRadius(99), Padding = new Thickness(10, 4, 10, 4), HorizontalAlignment = HorizontalAlignment.Left, Child = _pill };
        pillHost.SetResourceReference(Border.BackgroundProperty, "OkSoft");
        _pill.SetResourceReference(TextBlock.ForegroundProperty, "Ok");
        _heroTitle.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        _heroBody.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var hero = new StackPanel();
        hero.Children.Add(pillHost);
        hero.Children.Add(_heroTitle);
        hero.Children.Add(_heroBody);
        _hero.Child = hero;
        _hero.SetResourceReference(Border.BackgroundProperty, "AccentSoft");
        _hero.Padding = new Thickness(22, 20, 22, 20);
        Children.Add(_hero);

        var metrics = new UniformGrid { Columns = 2 };
        metrics.Children.Add(Metric(UiText.Get("protected"), _folders));
        metrics.Children.Add(Metric(UiText.Get("files"), _files));
        metrics.Children.Add(Metric(UiText.Get("backupSize"), _size));
        metrics.Children.Add(Metric(UiText.Get("last"), _last));
        Children.Add(metrics);

        Ui.ApplyStyle(_meter, "Meter");
        var storage = new StackPanel();
        storage.Children.Add(Label(UiText.Get("storage")));
        storage.Children.Add(_storage);
        storage.Children.Add(_meter);
        Children.Add(Card(storage));

        var activity = new StackPanel();
        activity.Children.Add(Label(UiText.Get("uploading")));
        activity.Children.Add(_activity);
        Children.Add(Card(activity));
    }

    public void Update(JsonElement status)
    {
        var server = MainWindow.Object(status, "server");
        var storage = MainWindow.Object(status, "storage");
        var overview = MainWindow.Object(status, "overview");
        var connected = MainWindow.Bool(server, "connected");
        var paused = MainWindow.Bool(status, "paused");
        var active = MainWindow.LongOf(status, "activeUploads");
        string pill;
        string title;
        string body;
        string tone;
        if (!connected)
        {
            pill = UiText.Get("heroSignIn");
            title = UiText.Get("connect");
            body = UiText.Get("heroBodySignIn");
            tone = "Warning";
        }
        else if (paused)
        {
            pill = UiText.Get("heroPaused");
            title = string.IsNullOrEmpty(MainWindow.TextOf(status, "pauseReason")) ? UiText.Get("heroPaused") : MainWindow.TextOf(status, "pauseReason");
            body = UiText.Get("heroBodyPaused");
            tone = "Warning";
        }
        else if (active > 0)
        {
            pill = UiText.Get("heroUploading");
            title = UiText.Get("heroUploading");
            body = UiText.Get("heroBodyUploading");
            tone = "Accent";
        }
        else
        {
            pill = UiText.Get("heroProtected");
            title = UiText.Get("ready");
            body = UiText.Get("heroBodyProtected");
            tone = "Ok";
        }

        _pill.Text = pill;
        _pill.SetResourceReference(TextBlock.ForegroundProperty, tone);
        if (_pill.Parent is Border pillHost)
        {
            pillHost.SetResourceReference(Border.BackgroundProperty, tone + "Soft");
        }

        _hero.SetResourceReference(Border.BackgroundProperty, tone == "Accent" ? "AccentSoft" : tone + "Soft");
        _heroTitle.Text = title;
        var email = MainWindow.TextOf(server, "accountEmail");
        var host = MainWindow.TextOf(server, "name");
        _heroBody.Text = body + (string.IsNullOrEmpty(email) && string.IsNullOrEmpty(host) ? "" : $"\n{email}  {host}".Trim());

        _folders.Text = MainWindow.LongOf(overview, "protectedFolders").ToString("N0");
        _files.Text = MainWindow.LongOf(overview, "filesBackedUp").ToString("N0");
        _size.Text = ByteFormat.Format(MainWindow.LongOf(overview, "backupBytes"));
        var last = MainWindow.TextOf(overview, "lastBackupAt");
        _last.Text = string.IsNullOrEmpty(last) ? "—" : last;

        if (storage.ValueKind != JsonValueKind.Object)
        {
            _storage.Text = "—";
            _meter.Value = 0;
        }
        else if (MainWindow.Bool(storage, "unlimited"))
        {
            _storage.Text = $"{UiText.Get("unlimited")} · {UiText.Get("used")} {ByteFormat.Format(MainWindow.LongOf(storage, "usedBytes"))}";
            _meter.Value = 0;
        }
        else
        {
            var used = MainWindow.LongOf(storage, "usedBytes");
            var quota = MainWindow.LongOf(storage, "quotaBytes");
            var percent = storage.TryGetProperty("percentUsed", out var value) && value.TryGetDouble(out var number) ? number : 0;
            _storage.Text = $"{ByteFormat.Format(used)} / {ByteFormat.Format(quota)} · {percent:0}%";
            _meter.Value = Math.Clamp(percent, 0, 100);
        }

        var speed = status.TryGetProperty("bytesPerSecond", out var rate) && rate.TryGetDouble(out var perSecond) ? perSecond : 0;
        var remaining = MainWindow.LongOf(status, "remainingBytes");
        _activity.Text =
            $"{UiText.Get("uploading")}: {active:N0}\n{UiText.Get("speed")}: {ByteFormat.FormatSpeed(speed)}\n{UiText.Get("remaining")}: {ByteFormat.Format(remaining)}\n{UiText.Get("eta")}: {OrDash(ByteFormat.FormatEta(remaining, speed))}";
    }

    private static string OrDash(string value) => string.IsNullOrEmpty(value) ? "—" : value;

    private static Border CardHost() => new()
    {
        CornerRadius = new CornerRadius(18),
        Padding = new Thickness(18),
        Margin = new Thickness(0, 0, 8, 12),
        BorderThickness = new Thickness(1),
    };

    private static TextBlock MetricValue() => new()
    {
        FontSize = 28,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 8, 0, 0),
        Text = "—",
    };

    private static Border Metric(string label, TextBlock value)
    {
        value.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        var stack = new StackPanel();
        stack.Children.Add(Label(label));
        stack.Children.Add(value);
        var card = CardHost();
        card.SetResourceReference(Border.BackgroundProperty, "Card");
        card.SetResourceReference(Border.BorderBrushProperty, "Line");
        card.Child = stack;
        return card;
    }

    private static TextBlock Label(string text)
    {
        var block = new TextBlock { Text = text, FontSize = 12.5 };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return block;
    }

    private static TextBlock Body()
    {
        var block = new TextBlock { TextWrapping = TextWrapping.Wrap, LineHeight = 22 };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        return block;
    }

    private static Border Card(UIElement child)
    {
        var card = CardHost();
        card.Margin = new Thickness(0, 4, 0, 12);
        card.SetResourceReference(Border.BackgroundProperty, "Card");
        card.SetResourceReference(Border.BorderBrushProperty, "Line");
        card.Child = child;
        return card;
    }
}

public sealed class BackupsView : DockPanel, IRefresh
{
    private readonly StackPanel _jobs = new();
    private string _signature = "";

    public BackupsView()
    {
        var bar = new DockPanel { Margin = new Thickness(0, 0, 0, 16), LastChildFill = false };
        var add = Ui.Button(UiText.Get("addFolder"), "PrimaryButton", AddJobAsync);
        add.Margin = new Thickness(0);
        bar.Children.Add(add);
        DockPanel.SetDock(bar, Dock.Top);
        Children.Add(bar);
        Children.Add(new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = _jobs, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
        LastChildFill = true;
    }

    public void Update(JsonElement status)
    {
        var signature = status.TryGetProperty("jobs", out var jobs) ? jobs.GetRawText() : "";
        if (signature == _signature && _jobs.Children.Count > 0)
        {
            return;
        }

        _signature = signature;
        _jobs.Children.Clear();
        if (jobs.ValueKind != JsonValueKind.Array || jobs.GetArrayLength() == 0)
        {
            _jobs.Children.Add(Ui.Empty(UiText.Get("noJobs"), UiText.Get("noJobsBody")));
            return;
        }

        foreach (var job in jobs.EnumerateArray())
        {
            _jobs.Children.Add(JobCard(job));
        }
    }

    private static Border JobCard(JsonElement job)
    {
        var id = MainWindow.TextOf(job, "id");
        var paused = MainWindow.Bool(job, "paused");
        var stack = new StackPanel();
        var header = new DockPanel();
        var pill = Ui.Pill(paused ? UiText.Get("paused") : UiText.Get("running"), paused ? "Warning" : "Ok");
        DockPanel.SetDock(pill, Dock.Right);
        header.Children.Add(pill);
        var name = new TextBlock { Text = MainWindow.TextOf(job, "name"), FontSize = 18, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
        name.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        header.Children.Add(name);
        stack.Children.Add(header);
        stack.Children.Add(Ui.MutedText(MainWindow.TextOf(job, "sourcePath")));
        var mode = MainWindow.TextOf(job, "mode");
        var modeLabel = UiText.Get(mode is "continuous" or "scheduled" or "manual" ? mode : "continuous");
        stack.Children.Add(Ui.MutedText($"{UiText.Get("destination")}: {MainWindow.TextOf(job, "destination")}  ·  {modeLabel}"));
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 14, 0, 0) };
        row.Children.Add(Ui.Button(UiText.Get("backupNow"), "PrimaryButton", () => Ui.TryCall(new { method = "backup.now", id })));
        row.Children.Add(Ui.Button(paused ? UiText.Get("resume") : UiText.Get("pause"), "SecondaryButton", () => Ui.TryCall(new { method = paused ? "resume" : "pause", id })));
        row.Children.Add(Ui.Button(UiText.Get("remove"), "QuietButton", () => RemoveAsync(id)));
        stack.Children.Add(row);
        return Ui.Card(stack);
    }

    private static async Task RemoveAsync(string id)
    {
        if (MessageBox.Show(UiText.Get("removeConfirm"), "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
        {
            return;
        }

        await Ui.TryCall(new { method = "jobs.delete", id, confirm = true });
    }

    private static async Task AddJobAsync()
    {
        using var dialog = new System.Windows.Forms.FolderBrowserDialog { Description = UiText.Get("choose"), UseDescriptionForTitle = true };
        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK)
        {
            return;
        }

        var name = new System.IO.DirectoryInfo(dialog.SelectedPath).Name;
        var destination = "Backups/" + Environment.MachineName + "/" + name;
        await Ui.TryCall(new
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

public sealed class TransfersView : StackPanel, IRefresh
{
    private readonly TextBlock _speed = MetricValue();
    private readonly TextBlock _active = MetricValue();
    private readonly TextBlock _queue = MetricValue();
    private readonly TextBlock _sent = MetricValue();
    private readonly Polyline _chart = new() { StrokeThickness = 2.4 };
    private readonly Canvas _canvas = new() { Height = 120 };
    private readonly StackPanel _rows = new();
    private readonly Dictionary<string, TransferRow> _cards = new(StringComparer.Ordinal);
    private Border? _empty;
    private double[] _lastSpeeds = [];

    public TransfersView()
    {
        var metrics = new UniformGrid { Columns = 4 };
        metrics.Children.Add(Mini(UiText.Get("speed"), _speed));
        metrics.Children.Add(Mini(UiText.Get("uploading"), _active));
        metrics.Children.Add(Mini(UiText.Get("queue"), _queue));
        metrics.Children.Add(Mini(UiText.Get("session"), _sent));
        Children.Add(metrics);

        _chart.SetResourceReference(Shape.StrokeProperty, "Accent");
        _canvas.Children.Add(_chart);
        _canvas.SizeChanged += (_, _) => Draw(_canvas, _lastSpeeds);
        var chartCard = new StackPanel();
        chartCard.Children.Add(Caption(UiText.Get("speedChart")));
        chartCard.Children.Add(_canvas);
        Children.Add(Ui.Card(chartCard));
        Children.Add(_rows);
    }

    public void Update(JsonElement status)
    {
        var speed = status.TryGetProperty("bytesPerSecond", out var rate) && rate.TryGetDouble(out var perSecond) ? perSecond : 0;
        _speed.Text = ByteFormat.FormatSpeed(speed);
        _active.Text = MainWindow.LongOf(status, "activeUploads").ToString("N0");
        _queue.Text = MainWindow.LongOf(status, "queueSize").ToString("N0");
        _sent.Text = ByteFormat.Format(MainWindow.LongOf(status, "sessionUploadedBytes"));
        var speeds = status.TryGetProperty("transferSpeeds", out var map) ? map : default;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var any = false;
        if (status.TryGetProperty("transfers", out var transfers) && transfers.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in transfers.EnumerateArray())
            {
                any = true;
                var id = MainWindow.TextOf(item, "id");
                if (string.IsNullOrEmpty(id))
                {
                    id = MainWindow.TextOf(item, "relativePath");
                }

                seen.Add(id);
                var fileSpeed = speeds.ValueKind == JsonValueKind.Object
                    && speeds.TryGetProperty(id, out var own)
                    && own.TryGetDouble(out var perFile)
                    && perFile > 0
                    ? perFile
                    : speed;
                if (_cards.TryGetValue(id, out var row))
                {
                    row.Update(item, fileSpeed);
                }
                else
                {
                    row = new TransferRow(item, fileSpeed);
                    _cards[id] = row;
                    _rows.Children.Add(row.Card);
                }
            }
        }

        foreach (var id in _cards.Keys.Where(key => !seen.Contains(key)).ToArray())
        {
            _rows.Children.Remove(_cards[id].Card);
            _cards.Remove(id);
        }

        if (!any)
        {
            if (_empty == null)
            {
                _empty = Ui.Empty(UiText.Get("noTransfers"), UiText.Get("noTransfersBody"));
                _rows.Children.Add(_empty);
            }
        }
        else if (_empty != null)
        {
            _rows.Children.Remove(_empty);
            _empty = null;
        }

        if (status.TryGetProperty("speedHistory", out var history) && history.ValueKind == JsonValueKind.Array)
        {
            _lastSpeeds = history.EnumerateArray().Select(item => item.TryGetDouble(out var number) ? number : 0).ToArray();
            Draw(_canvas, _lastSpeeds);
        }
    }

    private sealed class TransferRow
    {
        private readonly TextBlock _name;
        private readonly TextBlock _detail;
        private readonly ProgressBar _bar;
        private readonly TextBlock _extra;
        private string _error = "";
        private string _state = "";

        public TransferRow(JsonElement item, double speed)
        {
            _name = new TextBlock { FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap };
            _name.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            _detail = Ui.MutedText("");
            _bar = new ProgressBar { Margin = new Thickness(0, 10, 0, 0) };
            Ui.ApplyStyle(_bar, "Meter");
            _extra = Ui.MutedText("");
            var stack = new StackPanel();
            stack.Children.Add(_name);
            stack.Children.Add(_detail);
            stack.Children.Add(_bar);
            stack.Children.Add(_extra);
            Card = Ui.Card(stack);
            Update(item, speed);
        }

        public Border Card { get; }

        public void Update(JsonElement item, double speed)
        {
            var size = MainWindow.LongOf(item, "fileSize");
            var sent = MainWindow.LongOf(item, "bytesSent");
            var state = MainWindow.TextOf(item, "state");
            var error = MainWindow.TextOf(item, "error");
            _name.Text = MainWindow.TextOf(item, "relativePath");
            _detail.Text = $"{state}  ·  {ByteFormat.Format(sent)} / {ByteFormat.Format(size)}";
            _bar.Value = size <= 0 ? 0 : sent * 100d / size;
            if (error != _error || state != _state)
            {
                _error = error;
                _state = state;
                _extra.SetResourceReference(TextBlock.ForegroundProperty, string.IsNullOrEmpty(error) ? "Muted" : "Danger");
            }

            if (!string.IsNullOrEmpty(error))
            {
                _extra.Text = error;
            }
            else if (state == "Uploading")
            {
                var eta = ByteFormat.FormatEta(size - sent, speed);
                _extra.Text = string.IsNullOrEmpty(eta)
                    ? ByteFormat.FormatSpeed(speed)
                    : $"{ByteFormat.FormatSpeed(speed)}  ·  {UiText.Get("eta")} {eta}";
            }
            else
            {
                _extra.Text = "";
            }
        }
    }

    private static TextBlock MetricValue() => new() { FontSize = 22, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 6, 0, 0), Text = "—" };

    private static Border Mini(string label, TextBlock value)
    {
        value.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        var stack = new StackPanel();
        stack.Children.Add(Caption(label));
        stack.Children.Add(value);
        return Ui.Card(stack);
    }

    private static TextBlock Caption(string text)
    {
        var block = new TextBlock { Text = text, FontSize = 12.5 };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return block;
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
            var y = canvas.ActualHeight - (speeds[i] / max * (canvas.ActualHeight - 8)) - 4;
            _chart.Points.Add(new Point(x, y));
        }
    }
}

public sealed class ActivityView : DockPanel, IRefresh
{
    private readonly StackPanel _rows = new();
    private string _filter = "All";
    private string _signature = "";
    private bool _loading;

    public ActivityView()
    {
        var filters = new WrapPanel { Margin = new Thickness(0, 0, 0, 14) };
        foreach (var filter in new[] { "All", "Uploaded", "Skipped", "Failed", "Deleted" })
        {
            var selected = filter;
            var button = Ui.Button(UiText.Get(filter.ToLowerInvariant()), filter == "All" ? "PrimaryButton" : "SecondaryButton", async () =>
            {
                _filter = selected;
                _signature = "";
                await ReloadAsync();
            });
            filters.Children.Add(button);
        }

        DockPanel.SetDock(filters, Dock.Top);
        Children.Add(filters);
        Children.Add(new ScrollViewer { Content = _rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        LastChildFill = true;
    }

    public void Update(JsonElement status) => _ = ReloadAsync();

    private async Task ReloadAsync()
    {
        if (_loading)
        {
            return;
        }

        _loading = true;
        try
        {
            var response = await AgentConnection.CallAsync(new { method = "activity", filter = _filter });
            if (!response.GetProperty("ok").GetBoolean())
            {
                return;
            }

            var payload = response.GetProperty("result").GetRawText();
            if (payload == _signature)
            {
                return;
            }

            _signature = payload;
            _rows.Children.Clear();
            if (response.GetProperty("result").GetArrayLength() == 0)
            {
                _rows.Children.Add(Ui.Empty(UiText.Get("noActivity"), UiText.Get("noActivityBody")));
                return;
            }

            foreach (var entry in response.GetProperty("result").EnumerateArray())
            {
                var stack = new StackPanel();
                var kind = MainWindow.TextOf(entry, "kind");
                stack.Children.Add(Ui.Pill(string.IsNullOrEmpty(kind) ? UiText.Get("all") : kind, kind == "Failed" ? "Danger" : "Accent"));
                var path = new TextBlock { Text = MainWindow.TextOf(entry, "path"), FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
                path.SetResourceReference(TextBlock.ForegroundProperty, "Text");
                stack.Children.Add(path);
                var reason = MainWindow.TextOf(entry, "reason");
                stack.Children.Add(Ui.MutedText(MainWindow.TextOf(entry, "at") + (string.IsNullOrEmpty(reason) ? "" : "\n" + reason)));
                _rows.Children.Add(Ui.Card(stack));
            }
        }
        catch (BackupServiceUnavailableException ex)
        {
            Ui.Report?.Invoke(ex);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or InvalidOperationException)
        {
        }
        finally
        {
            _loading = false;
        }
    }
}

public sealed class SettingsView : StackPanel, IRefresh
{
    private readonly Func<Task> _refresh;
    private JsonElement _settings;
    private JsonElement _status;
    private TextBlock? _account;
    private bool _loaded;
    private bool _loading;
    private string _language = "";

    public SettingsView(Func<Task> refresh) => _refresh = refresh;

    public void Update(JsonElement status)
    {
        _status = status;
        if (_loaded && _account != null && _language == UiText.Language)
        {
            _account.Text = AccountText();
            return;
        }

        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        if (_loading)
        {
            return;
        }

        _loading = true;
        try
        {
            var response = await Ui.TryCall(new { method = "settings.get" });
            if (response == null || !response.Value.GetProperty("ok").GetBoolean())
            {
                return;
            }

            _settings = response.Value.GetProperty("result");
            _language = UiText.Language;
            Children.Clear();
            _account = new TextBlock { Text = AccountText(), TextWrapping = TextWrapping.Wrap, LineHeight = 22, Margin = new Thickness(0, 0, 0, 8) };
            _account.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            var account = new StackPanel();
            account.Children.Add(Heading(UiText.Get("sectionAccount")));
            account.Children.Add(_account);
            Children.Add(Ui.Card(account));

            var server = _status.ValueKind == JsonValueKind.Object && _status.TryGetProperty("server", out var value) ? value : default;
            var serverBox = new TextBox { Text = MainWindow.TextOf(server, "url") };
            Ui.ApplyStyle(serverBox, "Field");
            var insecure = new CheckBox { Content = UiText.Get("allowHttp"), IsChecked = MainWindow.Bool(server, "allowInsecure") };
            Ui.ApplyStyle(insecure, "Check");
            var actions = new WrapPanel();
            actions.Children.Add(Ui.Button(UiText.Get("test"), "SecondaryButton", async () => Show(await Ui.TryCall(new { method = "server.test", url = serverBox.Text, allowInsecure = insecure.IsChecked == true }))));
            actions.Children.Add(Ui.Button(UiText.Get("changeServer"), "SecondaryButton", async () =>
            {
                if (!Confirm(UiText.Get("changeConfirm")))
                {
                    return;
                }

                await ShowAndRefresh(await Ui.TryCall(new { method = "server.set", url = serverBox.Text, allowInsecure = insecure.IsChecked == true, confirm = true }));
            }));
            actions.Children.Add(Ui.Button(UiText.Get("disconnect"), "QuietButton", async () =>
            {
                if (!Confirm(UiText.Get("disconnectConfirm")))
                {
                    return;
                }

                await ShowAndRefresh(await Ui.TryCall(new { method = "auth.logout", confirm = true }));
            }));
            var serverCard = new StackPanel();
            serverCard.Children.Add(Heading(UiText.Get("server")));
            serverCard.Children.Add(Caption(UiText.Get("setupHint")));
            serverCard.Children.Add(serverBox);
            serverCard.Children.Add(insecure);
            serverCard.Children.Add(actions);
            Children.Add(Ui.Card(serverCard));

            Children.Add(Section(UiText.Get("sectionBackup"), UiText.Get("backupDefaultsBody"),
                Editor(UiText.Get("defaultDestination"), "defaultDestination"),
                Choice(UiText.Get("deletionPolicy"), "deletionPolicy", false,
                    ("keep", UiText.Get("keep")),
                    ("trash", UiText.Get("trash")),
                    ("delay", UiText.Get("delay")))));
            Children.Add(Section(UiText.Get("sectionFilters"), UiText.Get("filtersBody"),
                Check(UiText.Get("hidden"), "backupHiddenFiles"),
                Check(UiText.Get("system"), "backupSystemFiles"),
                Check(UiText.Get("symlinks"), "followSymlinks")));
            Children.Add(Section(UiText.Get("sectionTransfer"), UiText.Get("transferBody"),
                Choice(UiText.Get("concurrent"), "concurrentUploads", true, ("1", "1"), ("2", "2"), ("3", "3"), ("4", "4"), ("5", "5"), ("8", "8")),
                Choice(UiText.Get("chunk"), "chunkSizeMb", true, ("8", "8 MB"), ("16", "16 MB"), ("32", "32 MB"), ("64", "64 MB")),
                Choice(UiText.Get("limit"), "uploadLimitBytesPerSecond", true, ("", UiText.Get("unlimited")), ("10485760", "10 MB/s"), ("20971520", "20 MB/s"), ("52428800", "50 MB/s"))));
            Children.Add(Section(UiText.Get("sectionNetwork"), UiText.Get("networkBody"),
                Check(UiText.Get("wifi"), "backupOnWifi"),
                Check(UiText.Get("ethernet"), "backupOnEthernet"),
                Check(UiText.Get("metered"), "backupOnMetered")));
            Children.Add(Section(UiText.Get("sectionApp"), UiText.Get("appBody"),
                Check(UiText.Get("startWithWindows"), "startWithWindows"),
                Check(UiText.Get("background"), "runInBackground"),
                Check(UiText.Get("notifications"), "notifications"),
                Choice(UiText.Get("language"), "language", false, ("auto", "Auto"), ("en", "English"), ("vi", "Tiếng Việt")),
                Choice(UiText.Get("theme"), "theme", false, ("system", "System"), ("light", "Light"), ("dark", "Dark"))));

            var advanced = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
            advanced.Children.Add(Ui.Button(UiText.Get("openLogs"), "SecondaryButton", OpenLogsAsync));
            advanced.Children.Add(Ui.Button(UiText.Get("exportLogs"), "SecondaryButton", ExportLogsAsync));
            advanced.Children.Add(Ui.Button(UiText.Get("clearLogs"), "SecondaryButton", async () =>
            {
                if (Confirm(UiText.Get("clearConfirm")))
                {
                    await ShowAndRefresh(await Ui.TryCall(new { method = "logs.clear", confirm = true }));
                }
            }));
            advanced.Children.Add(Ui.Button(UiText.Get("rebuild"), "SecondaryButton", async () =>
            {
                if (Confirm(UiText.Get("rebuildConfirm")))
                {
                    await ShowAndRefresh(await Ui.TryCall(new { method = "index.rebuild", confirm = true }));
                }
            }));
            advanced.Children.Add(Ui.Button(UiText.Get("verify"), "SecondaryButton", async () =>
            {
                if (Confirm(UiText.Get("verifyConfirm")))
                {
                    await ShowAndRefresh(await Ui.TryCall(new { method = "integrity.verify", confirm = true }));
                }
            }));
            var advancedCard = new StackPanel();
            advancedCard.Children.Add(Heading(UiText.Get("sectionAdvanced")));
            advancedCard.Children.Add(Ui.MutedText(UiText.Get("advancedBody")));
            advancedCard.Children.Add(advanced);
            Children.Add(Ui.Card(advancedCard));

            var save = Ui.Button(UiText.Get("saveSettings"), "PrimaryButton", async () =>
            {
                Show(await Ui.TryCall(new { method = "settings.set", settings = JsonSerializer.Deserialize<JsonElement>(_settings.GetRawText()) }));
                await _refresh();
            });
            save.Margin = new Thickness(0, 4, 0, 0);
            save.HorizontalAlignment = HorizontalAlignment.Left;
            Children.Add(save);
            _loaded = true;
        }
        finally
        {
            _loading = false;
        }
    }

    private string AccountText()
    {
        var server = _status.ValueKind == JsonValueKind.Object && _status.TryGetProperty("server", out var value) ? value : default;
        var email = MainWindow.TextOf(server, "accountEmail");
        return string.Join("\n", new[]
        {
            $"{UiText.Get("account")}: {(string.IsNullOrEmpty(email) ? "—" : email)}",
            $"{UiText.Get("server")}: {OrDash(MainWindow.TextOf(server, "url"))}",
            $"{UiText.Get("connectedTo")}: {(MainWindow.Bool(server, "connected") ? UiText.Get("authorized") : "—")}",
            $"API {OrDash(MainWindow.TextOf(server, "apiVersion"))}",
        });
    }

    private static string OrDash(string value) => string.IsNullOrEmpty(value) ? "—" : value;

    private UIElement Editor(string label, string property)
    {
        var box = new TextBox { Text = MainWindow.TextOf(_settings, property) };
        Ui.ApplyStyle(box, "Field");
        box.TextChanged += (_, _) => _settings = Replace(_settings, property, box.Text);
        return Labeled(label, box);
    }

    private UIElement Choice(string label, string property, bool numeric, params (string Value, string Label)[] options)
    {
        var box = new ComboBox();
        Ui.ApplyStyle(box, "Choice");
        foreach (var option in options)
        {
            box.Items.Add(new ComboBoxItem { Content = option.Label, Tag = option.Value });
        }

        var current = Stored(_settings, property);
        foreach (ComboBoxItem item in box.Items)
        {
            if ((item.Tag as string ?? "") == current)
            {
                box.SelectedItem = item;
                break;
            }
        }

        box.SelectedItem ??= box.Items[0];
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedItem is not ComboBoxItem item)
            {
                return;
            }

            var selected = item.Tag as string ?? "";
            object? written = selected.Length == 0
                ? null
                : numeric && long.TryParse(selected, out var number) ? number : selected;
            _settings = Replace(_settings, property, written);
        };
        return Labeled(label, box);
    }

    private CheckBox Check(string label, string property)
    {
        var box = new CheckBox { Content = label, IsChecked = MainWindow.Bool(_settings, property) };
        Ui.ApplyStyle(box, "Check");
        box.Checked += (_, _) => _settings = Replace(_settings, property, true);
        box.Unchecked += (_, _) => _settings = Replace(_settings, property, false);
        return box;
    }

    private static string Stored(JsonElement settings, string property)
    {
        if (settings.ValueKind != JsonValueKind.Object || !settings.TryGetProperty(property, out var value))
        {
            return "";
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.ToString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };
    }

    private static JsonElement Replace(JsonElement element, string property, object? value)
    {
        var map = element.ValueKind == JsonValueKind.Object
            ? JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(element.GetRawText()) ?? new Dictionary<string, JsonElement>()
            : new Dictionary<string, JsonElement>();
        map[property] = value is null
            ? JsonDocument.Parse("null").RootElement.Clone()
            : JsonSerializer.SerializeToElement(value);
        return JsonSerializer.SerializeToElement(map);
    }

    private void Show(JsonElement? response)
    {
        if (response == null || response.Value.GetProperty("ok").GetBoolean())
        {
            return;
        }

        MessageBox.Show(MainWindow.TextOf(response.Value, "message"), "My Drive Backup", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private async Task ShowAndRefresh(JsonElement? response)
    {
        Show(response);
        if (response != null)
        {
            await _refresh();
        }
    }

    private async Task OpenLogsAsync()
    {
        var logs = await Ui.TryCall(new { method = "logs.list" });
        if (logs == null)
        {
            return;
        }

        var text = logs.Value.GetProperty("ok").GetBoolean()
            ? string.Join("\n", logs.Value.GetProperty("result").EnumerateArray().Select(entry => $"{MainWindow.TextOf(entry, "at")} {MainWindow.TextOf(entry, "level")} {MainWindow.TextOf(entry, "message")}"))
            : MainWindow.TextOf(logs.Value, "message");
        MessageBox.Show(string.IsNullOrEmpty(text) ? UiText.Get("noLogs") : text, UiText.Get("logsTitle"));
    }

    private async Task ExportLogsAsync()
    {
        var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "mydrive-backup.log", Filter = "Log|*.log" };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        var exported = await Ui.TryCall(new { method = "logs.export" });
        if (exported == null || !exported.Value.GetProperty("ok").GetBoolean())
        {
            return;
        }

        await File.WriteAllTextAsync(dialog.FileName, exported.Value.GetProperty("result").GetProperty("text").GetString() ?? "");
    }

    private static bool Confirm(string message) =>
        MessageBox.Show(message, "My Drive Backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning) == MessageBoxResult.OK;

    private static Border Section(string title, string body, params UIElement[] extra)
    {
        var stack = new StackPanel();
        stack.Children.Add(Heading(title));
        stack.Children.Add(Ui.MutedText(body));
        foreach (var item in extra)
        {
            stack.Children.Add(item);
        }

        return Ui.Card(stack);
    }

    private static TextBlock Heading(string text)
    {
        var block = new TextBlock { Text = text, FontSize = 16, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        return block;
    }

    private static TextBlock Caption(string text)
    {
        var block = new TextBlock { Text = text, FontSize = 12.5 };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return block;
    }

    private static StackPanel Labeled(string label, UIElement child)
    {
        var stack = new StackPanel();
        stack.Children.Add(Caption(label));
        stack.Children.Add(child);
        return stack;
    }
}

public sealed class SetupView : StackPanel, IRefresh
{
    private readonly TextBox _url = new() { Text = "https://" };
    private readonly CheckBox _insecure = new() { Content = UiText.Get("allowHttp") };
    private readonly TextBlock _detail = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 16, 0, 0), LineHeight = 22 };
    private readonly Func<Task> _refresh;
    private int _step;

    public SetupView(Func<Task> refresh)
    {
        _refresh = refresh;
        var title = new TextBlock { Text = UiText.Get("connect"), FontSize = 28, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap };
        title.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        Children.Add(title);
        Children.Add(Ui.MutedText(UiText.Get("setupIntro")));
        Children.Add(Caption(UiText.Get("setupHint")));
        Ui.ApplyStyle(_url, "Field");
        Children.Add(_url);
        Ui.ApplyStyle(_insecure, "Check");
        Children.Add(_insecure);
        var row = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
        row.Children.Add(Ui.Button(UiText.Get("test"), "SecondaryButton", TestAsync));
        row.Children.Add(Ui.Button(UiText.Get("signIn"), "PrimaryButton", AuthorizeAsync));
        row.Children.Add(Ui.Button(UiText.Get("start"), "SecondaryButton", async () =>
        {
            await Ui.TryCall(new { method = "backup.now" });
            await _refresh();
        }));
        Children.Add(row);
        _detail.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        _detail.Text = UiText.Get("setupIntro");
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
            var waiting = UiText.Get("approve");
            _detail.Text = string.IsNullOrEmpty(code) ? waiting : $"{UiText.Get("userCode")} {code}\n{waiting}";
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

        if (_step == 0)
        {
            return;
        }

        if (_step == 1)
        {
            _detail.Text = string.IsNullOrEmpty(detail) ? UiText.Get("approve") : detail;
        }
    }

    private async Task TestAsync()
    {
        var response = await Ui.TryCall(new { method = "server.test", url = _url.Text, allowInsecure = _insecure.IsChecked == true });
        if (response == null)
        {
            return;
        }

        if (!response.Value.GetProperty("ok").GetBoolean())
        {
            _detail.Text = MainWindow.TextOf(response.Value, "message");
            return;
        }

        var result = response.Value.GetProperty("result");
        _detail.Text = $"{UiText.Get("connectedTo")} {MainWindow.TextOf(result, "name")}\nAPI {MainWindow.TextOf(result, "apiVersion")} · {MainWindow.TextOf(result, "serverVersion")}";
        if (_url.Text.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            _detail.Text = UiText.Get("insecure") + "\n" + _detail.Text;
        }

        _step = 1;
    }

    private async Task AuthorizeAsync()
    {
        var saved = await Ui.TryCall(new { method = "server.set", url = _url.Text, allowInsecure = _insecure.IsChecked == true, confirm = true });
        if (saved == null || !saved.Value.GetProperty("ok").GetBoolean())
        {
            if (saved != null)
            {
                _detail.Text = MainWindow.TextOf(saved.Value, "message");
            }

            return;
        }

        var began = await Ui.TryCall(new { method = "auth.begin" });
        if (began == null || !began.Value.GetProperty("ok").GetBoolean())
        {
            if (began != null)
            {
                _detail.Text = MainWindow.TextOf(began.Value, "message");
            }

            return;
        }

        var uri = MainWindow.TextOf(began.Value.GetProperty("result"), "verificationUri");
        if (!string.IsNullOrWhiteSpace(uri))
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }

        _detail.Text = $"{UiText.Get("userCode")} {MainWindow.TextOf(began.Value.GetProperty("result"), "userCode")}\n{UiText.Get("approve")}";
        _step = 2;
    }

    private static TextBlock Caption(string text)
    {
        var block = new TextBlock { Text = text, FontSize = 12.5, Margin = new Thickness(0, 16, 0, 0) };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return block;
    }
}

internal static class Ui
{
    public static Action<Exception>? Report { get; set; }

    public static async Task<JsonElement?> TryCall(object request)
    {
        try
        {
            return await AgentConnection.CallAsync(request);
        }
        catch (Exception ex)
        {
            Report?.Invoke(ex);
            return null;
        }
    }

    public static void ApplyStyle(FrameworkElement element, string key)
    {
        if (System.Windows.Application.Current?.TryFindResource(key) is Style style)
        {
            element.Style = style;
        }
    }

    public static Button Button(string text, string style, Func<Task> action)
    {
        var button = new Button { Content = text };
        ApplyStyle(button, style);
        button.Click += async (_, _) =>
        {
            try
            {
                await action();
            }
            catch (Exception ex)
            {
                Report?.Invoke(ex);
            }
        };
        return button;
    }

    public static Border Card(UIElement child)
    {
        var border = new Border
        {
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(18),
            Margin = new Thickness(0, 0, 0, 12),
            BorderThickness = new Thickness(1),
            Child = child,
        };
        border.SetResourceReference(Border.BackgroundProperty, "Card");
        border.SetResourceReference(Border.BorderBrushProperty, "Line");
        return border;
    }

    public static Border Empty(string title, string body)
    {
        var stack = new StackPanel { Margin = new Thickness(8, 12, 8, 12) };
        var heading = new TextBlock { Text = title, FontSize = 18, FontWeight = FontWeights.SemiBold };
        heading.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        stack.Children.Add(heading);
        stack.Children.Add(MutedText(body));
        return Card(stack);
    }

    public static Border Pill(string text, string tone)
    {
        var label = new TextBlock { Text = text, FontSize = 12, FontWeight = FontWeights.SemiBold };
        label.SetResourceReference(TextBlock.ForegroundProperty, tone);
        var border = new Border
        {
            CornerRadius = new CornerRadius(99),
            Padding = new Thickness(10, 4, 10, 4),
            HorizontalAlignment = HorizontalAlignment.Left,
            Child = label,
        };
        border.SetResourceReference(Border.BackgroundProperty, tone + "Soft");
        return border;
    }

    public static TextBlock MutedText(string text)
    {
        var block = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0), FontSize = 13, LineHeight = 20 };
        block.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        return block;
    }
}
