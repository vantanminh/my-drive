namespace MyDrive.Backup;

/// <summary>
/// Counts bytes as they leave the client and turns that stream into a current
/// speed plus one bucket per second for the chart.
/// </summary>
public sealed class TransferMeter
{
    public const int WindowSeconds = 30;
    private static readonly TimeSpan RateWindow = TimeSpan.FromSeconds(3);
    private readonly object _gate = new();
    private readonly Queue<Sample> _samples = new();
    private long _sessionBytes;

    public void Add(DateTimeOffset at, long bytes, string? transferId)
    {
        if (bytes <= 0)
        {
            return;
        }

        lock (_gate)
        {
            _sessionBytes += bytes;
            _samples.Enqueue(new Sample(at, bytes, transferId));
            Trim(at);
        }
    }

    public void CorrectSession(long delta)
    {
        if (delta == 0)
        {
            return;
        }

        lock (_gate)
        {
            _sessionBytes = Math.Max(0, _sessionBytes + delta);
        }
    }

    public TransferReading Read(DateTimeOffset now)
    {
        lock (_gate)
        {
            Trim(now);
            var history = new double[WindowSeconds];
            var speeds = new Dictionary<string, (long Bytes, DateTimeOffset Oldest)>(StringComparer.Ordinal);
            long recent = 0;
            DateTimeOffset? oldestRecent = null;
            var rateStart = now - RateWindow;
            foreach (var sample in _samples)
            {
                var age = (now - sample.At).TotalSeconds;
                if (age < 0)
                {
                    age = 0;
                }

                if (age < WindowSeconds)
                {
                    var index = WindowSeconds - 1 - (int)Math.Floor(age);
                    if (index < 0)
                    {
                        index = 0;
                    }

                    history[index] += sample.Bytes;
                }

                if (sample.At < rateStart)
                {
                    continue;
                }

                recent += sample.Bytes;
                if (oldestRecent == null || sample.At < oldestRecent)
                {
                    oldestRecent = sample.At;
                }

                if (string.IsNullOrEmpty(sample.TransferId))
                {
                    continue;
                }

                if (!speeds.TryGetValue(sample.TransferId, out var current))
                {
                    speeds[sample.TransferId] = (sample.Bytes, sample.At);
                }
                else
                {
                    var oldest = sample.At < current.Oldest ? sample.At : current.Oldest;
                    speeds[sample.TransferId] = (current.Bytes + sample.Bytes, oldest);
                }
            }

            var transferSpeeds = new Dictionary<string, double>(StringComparer.Ordinal);
            foreach (var (id, value) in speeds)
            {
                transferSpeeds[id] = Rate(value.Bytes, value.Oldest, now);
            }

            var speed = oldestRecent == null ? 0 : Rate(recent, oldestRecent.Value, now);
            return new TransferReading(_sessionBytes, speed, history, transferSpeeds);
        }
    }

    private static double Rate(long bytes, DateTimeOffset oldest, DateTimeOffset now)
    {
        if (bytes <= 0)
        {
            return 0;
        }

        var elapsed = Math.Clamp((now - oldest).TotalSeconds, 0.2, RateWindow.TotalSeconds);
        return bytes / elapsed;
    }

    private void Trim(DateTimeOffset now)
    {
        var cutoff = now.AddSeconds(-WindowSeconds);
        while (_samples.Count > 0 && _samples.Peek().At < cutoff)
        {
            _samples.Dequeue();
        }
    }

    private readonly record struct Sample(DateTimeOffset At, long Bytes, string? TransferId);
}

public sealed record TransferReading(
    long SessionBytes,
    double BytesPerSecond,
    double[] History,
    IReadOnlyDictionary<string, double> TransferSpeeds);
