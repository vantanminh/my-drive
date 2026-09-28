using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;

namespace MyDrive.Backup;

public static class GlobMatcher
{
    private static readonly ConcurrentDictionary<string, Regex?> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static bool IsMatch(string pattern, string relativePath, string fileName)
    {
        var trimmed = pattern.Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        if (trimmed.StartsWith("regex:", StringComparison.OrdinalIgnoreCase))
        {
            var expression = trimmed["regex:".Length..];
            try
            {
                return Regex.IsMatch(
                    relativePath.Replace('\\', '/'),
                    expression,
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                    TimeSpan.FromMilliseconds(100));
            }
            catch (RegexMatchTimeoutException)
            {
                return false;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        var normalized = trimmed.Replace('\\', '/');
        var subject = normalized.Contains('/') ? relativePath.Replace('\\', '/') : fileName;
        var regex = Cache.GetOrAdd(normalized, Compile);
        if (regex == null)
        {
            return false;
        }

        try
        {
            return regex.IsMatch(subject);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    private static Regex? Compile(string pattern)
    {
        try
        {
            return new Regex(ToRegex(pattern), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    internal static string ToRegex(string pattern)
    {
        var builder = new StringBuilder("^");
        for (var i = 0; i < pattern.Length; i++)
        {
            var current = pattern[i];
            if (current == '*')
            {
                var doubled = i + 1 < pattern.Length && pattern[i + 1] == '*';
                if (doubled)
                {
                    i++;
                    if (i + 1 < pattern.Length && pattern[i + 1] == '/')
                    {
                        i++;
                    }

                    builder.Append(".*");
                }
                else
                {
                    builder.Append("[^/]*");
                }

                continue;
            }

            if (current == '?')
            {
                builder.Append("[^/]");
                continue;
            }

            builder.Append(Regex.Escape(current.ToString()));
        }

        builder.Append('$');
        return builder.ToString();
    }
}
