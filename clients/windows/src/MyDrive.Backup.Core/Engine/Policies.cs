namespace MyDrive.Backup;

public enum FailureKind
{
    Refresh,
    Permission,
    Missing,
    RateLimit,
    Retry,
    Network,
    Fatal,
}

public static class RetryPolicy
{
    public static readonly TimeSpan[] Delays =
    [
        TimeSpan.FromSeconds(5),
        TimeSpan.FromSeconds(15),
        TimeSpan.FromSeconds(30),
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(5),
    ];

    public static TimeSpan Delay(int retryCount) => Delays[Math.Clamp(retryCount, 0, Delays.Length - 1)];

    public static FailureKind Classify(Exception exception)
    {
        if (exception is ApiException api)
        {
            return api.Status switch
            {
                401 => FailureKind.Refresh,
                403 => FailureKind.Permission,
                404 => FailureKind.Missing,
                429 => FailureKind.RateLimit,
                >= 500 => FailureKind.Retry,
                _ => FailureKind.Fatal,
            };
        }

        if (exception is HttpRequestException or IOException or TimeoutException)
        {
            return FailureKind.Network;
        }

        return FailureKind.Fatal;
    }
}

public static class BandwidthPolicy
{
    public static long? EffectiveLimit(ClientSettings settings, DateTimeOffset localNow)
    {
        var minute = localNow.Hour * 60 + localNow.Minute;
        long? strictest = null;
        var matched = false;
        foreach (var window in new[] { settings.DayLimit, settings.NightLimit })
        {
            if (window == null || !Contains(window, minute))
            {
                continue;
            }

            matched = true;
            if (window.BytesPerSecond is not long limit)
            {
                continue;
            }

            strictest = strictest is null ? limit : Math.Min(strictest.Value, limit);
        }

        return matched ? strictest : settings.UploadLimitBytesPerSecond;
    }

    public static bool Contains(BandwidthWindow window, int minuteOfDay)
    {
        var start = Math.Clamp(window.StartMinutes, 0, 24 * 60);
        var end = Math.Clamp(window.EndMinutes, 0, 24 * 60);
        if (start == end)
        {
            return true;
        }

        if (start < end)
        {
            return minuteOfDay >= start && minuteOfDay < end;
        }

        return minuteOfDay >= start || minuteOfDay < end;
    }
}

public static class SchedulePolicy
{
    public static bool IsDue(BackupJob job, DateTimeOffset now, bool force)
    {
        if (job.Paused)
        {
            return false;
        }

        if (force || job.Mode == BackupModes.Manual)
        {
            return force;
        }

        if (job.Mode == BackupModes.Continuous)
        {
            return job.LastScanAt is null || now - job.LastScanAt.Value >= TimeSpan.FromMinutes(30);
        }

        var last = job.LastScanAt;
        return job.ScheduleKind switch
        {
            ScheduleKinds.Minutes => last is null || now - last.Value >= TimeSpan.FromMinutes(Math.Max(1, job.ScheduleEveryMinutes)),
            ScheduleKinds.Hourly => last is null || now - last.Value >= TimeSpan.FromHours(1),
            ScheduleKinds.Weekly => DueSlot(last, now, job.ScheduleHour, job.ScheduleMinute, job.ScheduleWeekday),
            _ => DueSlot(last, now, job.ScheduleHour, job.ScheduleMinute, null),
        };
    }

    private static bool DueSlot(DateTimeOffset? last, DateTimeOffset now, int hour, int minute, int? weekday)
    {
        var slot = new DateTimeOffset(now.Year, now.Month, now.Day, Math.Clamp(hour, 0, 23), Math.Clamp(minute, 0, 59), 0, now.Offset);
        if (weekday is int day)
        {
            while ((int)slot.DayOfWeek != Math.Clamp(day, 0, 6))
            {
                slot = slot.AddDays(-1);
            }
        }

        if (now < slot)
        {
            slot = slot.AddDays(weekday is null ? -1 : -7);
        }

        return last is null || last.Value < slot;
    }
}

public static class NetworkPolicy
{
    public static bool AllowsUpload(ClientSettings settings, NetworkSnapshot snapshot)
    {
        if (!snapshot.HasLink)
        {
            return false;
        }

        if (snapshot.MeteredKnown && snapshot.Metered && !settings.BackupOnMetered)
        {
            return false;
        }

        if (snapshot.Wifi && !snapshot.Ethernet)
        {
            return settings.BackupOnWifi;
        }

        if (snapshot.Ethernet && !snapshot.Wifi)
        {
            return settings.BackupOnEthernet;
        }

        return settings.BackupOnWifi || settings.BackupOnEthernet;
    }
}

public static class TransferLimits
{
    private static readonly int[] Uploads = [1, 2, 3, 4, 5, 8];

    public static int UploadsFor(int requested)
    {
        if (Uploads.Contains(requested))
        {
            return requested;
        }

        return Uploads.OrderBy(value => Math.Abs(value - requested)).ThenBy(value => value).First();
    }

    public static int HashersFor(int requested) => Math.Clamp(requested, 1, 4);

    public static int ChunkBytes(ClientSettings settings, ServerCapabilities? capabilities)
    {
        var requested = settings.ChunkSizeMb <= 0 ? 64 * 1024 : settings.ChunkSizeMb * 1024 * 1024;
        var cap = capabilities?.MaxChunkBytes > 0 ? capabilities.MaxChunkBytes : 64L * 1024 * 1024;
        return (int)Math.Clamp(Math.Min(requested, cap), 64 * 1024, 64L * 1024 * 1024);
    }
}

public static class ByteFormat
{
    public static string Format(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }

        return unit == 0 ? $"{bytes} B" : $"{value:0.#} {units[unit]}";
    }

    public static string FormatSpeed(double bytesPerSecond) => $"{Format((long)bytesPerSecond)}/s";

    public static string FormatEta(long remaining, double bytesPerSecond)
    {
        if (bytesPerSecond < 1 || remaining <= 0)
        {
            return "";
        }

        var seconds = (int)Math.Clamp(remaining / bytesPerSecond, 0, 24 * 3600);
        if (seconds < 60)
        {
            return $"{seconds}s";
        }

        return seconds < 3600 ? $"{seconds / 60}m {seconds % 60}s" : $"{seconds / 3600}h {(seconds % 3600) / 60}m";
    }
}

public static class RemotePath
{
    public static string Combine(string destination, string? relativeDirectory)
    {
        var root = (destination ?? "").Replace('\\', '/').Trim('/');
        var relative = (relativeDirectory ?? "").Replace('\\', '/').Trim('/');
        if (relative.Length == 0)
        {
            return root;
        }

        return root.Length == 0 ? relative : root + "/" + relative;
    }
}
