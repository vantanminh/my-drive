using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;

namespace MyDrive.Backup;

public interface ISecretStore
{
    void Save(string key, string value);

    string? Load(string key);

    void Delete(string key);
}

public sealed class MemorySecretStore : ISecretStore
{
    private readonly Dictionary<string, string> _values = new(StringComparer.Ordinal);

    public void Save(string key, string value) => _values[key] = value;

    public string? Load(string key) => _values.TryGetValue(key, out var value) ? value : null;

    public void Delete(string key) => _values.Remove(key);
}

public sealed class AesSecretStore : ISecretStore
{
    private readonly string _path;
    private readonly byte[] _key;
    private readonly Dictionary<string, string> _values;
    private readonly object _gate = new();

    public AesSecretStore(string directory)
    {
        Directory.CreateDirectory(directory);
        var keyPath = Path.Combine(directory, "secrets.key");
        if (!File.Exists(keyPath))
        {
            File.WriteAllBytes(keyPath, RandomNumberGenerator.GetBytes(32));
            TryRestrict(keyPath);
        }

        _key = File.ReadAllBytes(keyPath);
        _path = Path.Combine(directory, "secrets.bin");
        _values = Load();
    }

    public void Save(string key, string value)
    {
        lock (_gate)
        {
            _values[key] = value;
            Persist();
        }
    }

    public string? Load(string key)
    {
        lock (_gate)
        {
            return _values.TryGetValue(key, out var value) ? value : null;
        }
    }

    public void Delete(string key)
    {
        lock (_gate)
        {
            if (_values.Remove(key))
            {
                Persist();
            }
        }
    }

    private Dictionary<string, string> Load()
    {
        if (!File.Exists(_path))
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var payload = File.ReadAllBytes(_path);
        if (payload.Length < 12 + 16)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var nonce = payload.AsSpan(0, 12);
        var tag = payload.AsSpan(12, 16);
        var cipher = payload.AsSpan(28);
        var plain = new byte[cipher.Length];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(nonce, cipher, tag, plain);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(plain) ?? new Dictionary<string, string>(StringComparer.Ordinal);
    }

    private void Persist()
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(_values);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, plain, cipher, tag);
        var payload = new byte[nonce.Length + tag.Length + cipher.Length];
        nonce.CopyTo(payload, 0);
        tag.CopyTo(payload, nonce.Length);
        cipher.CopyTo(payload.AsSpan(nonce.Length + tag.Length));
        File.WriteAllBytes(_path, payload);
        TryRestrict(_path);
    }

    private static void TryRestrict(string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
        }
    }
}

[SupportedOSPlatform("windows")]
public sealed class DpapiSecretStore : ISecretStore
{
    private readonly string _path;
    private readonly Dictionary<string, string> _protected = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public DpapiSecretStore(string directory)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("DPAPI token storage is available on Windows.");
        }

        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "secrets.dpapi");
        if (!File.Exists(_path))
        {
            return;
        }

        var envelope = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllBytes(_path));
        if (envelope == null)
        {
            return;
        }

        foreach (var (key, value) in envelope)
        {
            _protected[key] = value;
        }
    }

    public void Save(string key, string value)
    {
        lock (_gate)
        {
            var protectedBytes = System.Security.Cryptography.ProtectedData.Protect(
                System.Text.Encoding.UTF8.GetBytes(value),
                null,
                System.Security.Cryptography.DataProtectionScope.CurrentUser);
            _protected[key] = Convert.ToBase64String(protectedBytes);
            Persist();
        }
    }

    public string? Load(string key)
    {
        lock (_gate)
        {
            if (!_protected.TryGetValue(key, out var encoded))
            {
                return null;
            }

            var plain = System.Security.Cryptography.ProtectedData.Unprotect(
                Convert.FromBase64String(encoded),
                null,
                System.Security.Cryptography.DataProtectionScope.CurrentUser);
            return System.Text.Encoding.UTF8.GetString(plain);
        }
    }

    public void Delete(string key)
    {
        lock (_gate)
        {
            if (_protected.Remove(key))
            {
                Persist();
            }
        }
    }

    private void Persist() => File.WriteAllBytes(_path, JsonSerializer.SerializeToUtf8Bytes(_protected));
}

public static class SecretRedactor
{
    public static string Redact(string? message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return "";
        }

        var text = System.Text.RegularExpressions.Regex.Replace(
            message,
            @"\bmd[brk]_[A-Za-z0-9_-]+",
            "[redacted]",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return System.Text.RegularExpressions.Regex.Replace(
            text,
            "(?i)(\"(?:password|access_token|refresh_token|device_code|secret|authorization)\"\\s*:\\s*\")[^\"]*\"",
            "$1[redacted]\"");
    }
}

public static class SecretKeys
{
    public static string Access(string serverUrl) => serverUrl.TrimEnd('/') + "|access";

    public static string Refresh(string serverUrl) => serverUrl.TrimEnd('/') + "|refresh";
}
