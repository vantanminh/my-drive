namespace MyDrive.Backup;

public sealed class FilterEngine
{
    public bool IncludeFile(ScannedFile file, BackupJob job, ClientSettings settings)
    {
        if (file.Symlink && !Resolve(job.FollowSymlinks, settings.FollowSymlinks))
        {
            return false;
        }

        if (file.System && !Resolve(job.BackupSystem, settings.BackupSystemFiles))
        {
            return false;
        }

        if (file.Hidden && !Resolve(job.BackupHidden, settings.BackupHiddenFiles))
        {
            return false;
        }

        if (job.MaxFileBytes is long max && file.Size > max)
        {
            return false;
        }

        if (job.MinFileBytes is long min && file.Size < min)
        {
            return false;
        }

        var extension = Path.GetExtension(file.Name);
        if (job.IncludeExtensions.Count > 0 && !job.IncludeExtensions.Any(item => ExtensionEquals(item, extension)))
        {
            return false;
        }

        if (job.ExcludeExtensions.Any(item => ExtensionEquals(item, extension)))
        {
            return false;
        }

        foreach (var pattern in job.ExcludePatterns)
        {
            if (GlobMatcher.IsMatch(pattern, file.RelativePath, file.Name))
            {
                return false;
            }
        }

        return true;
    }

    public bool ExcludeDirectory(string name, BackupJob job)
    {
        return job.ExcludeFolders.Any(folder => string.Equals(folder, name, StringComparison.OrdinalIgnoreCase));
    }

    private static bool Resolve(bool? jobValue, bool settingsValue) => jobValue ?? settingsValue;

    private static bool ExtensionEquals(string rule, string extension)
    {
        var normalized = rule.StartsWith('.') ? rule : "." + rule;
        return string.Equals(normalized, extension, StringComparison.OrdinalIgnoreCase);
    }
}

public static class FileScanner
{
    public static IEnumerable<ScannedFile> Enumerate(string root, BackupJob job, ClientSettings settings, CancellationToken cancellationToken)
    {
        var filter = new FilterEngine();
        var fullRoot = Path.GetFullPath(root);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var follow = job.FollowSymlinks ?? settings.FollowSymlinks;
        foreach (var file in Walk(fullRoot, "", 0))
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return file;
        }

        IEnumerable<ScannedFile> Walk(string directory, string relative, int depth)
        {
            if (depth > 64 || !visited.Add(directory))
            {
                yield break;
            }

            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(directory);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                yield break;
            }

            foreach (var entry in entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var name = Path.GetFileName(entry);
                if (name is "." or "..")
                {
                    continue;
                }

                var childRelative = relative.Length == 0 ? name : relative + "/" + name;
                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(entry);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;
                }

                var symlink = IsSymlink(entry, attributes);
                var directoryEntry = (attributes & FileAttributes.Directory) != 0;
                if (directoryEntry)
                {
                    if (filter.ExcludeDirectory(name, job))
                    {
                        continue;
                    }

                    if (symlink && !follow)
                    {
                        continue;
                    }

                    var hiddenDir = (attributes & FileAttributes.Hidden) != 0;
                    var systemDir = (attributes & FileAttributes.System) != 0;
                    if (hiddenDir && !(job.BackupHidden ?? settings.BackupHiddenFiles))
                    {
                        continue;
                    }

                    if (systemDir && !(job.BackupSystem ?? settings.BackupSystemFiles))
                    {
                        continue;
                    }

                    foreach (var nested in Walk(entry, childRelative, depth + 1))
                    {
                        yield return nested;
                    }

                    continue;
                }

                var info = new FileInfo(entry);
                var scanned = new ScannedFile(
                    entry,
                    childRelative.Replace('\\', '/'),
                    name,
                    info.Exists ? info.Length : 0,
                    new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    (attributes & FileAttributes.Hidden) != 0,
                    (attributes & FileAttributes.System) != 0,
                    symlink);
                if (filter.IncludeFile(scanned, job, settings))
                {
                    yield return scanned;
                }
            }
        }
    }

    private static bool IsSymlink(string path, FileAttributes attributes)
    {
        if ((attributes & FileAttributes.ReparsePoint) == 0)
        {
            return false;
        }

        try
        {
            return File.ResolveLinkTarget(path, returnFinalTarget: false) != null
                || Directory.ResolveLinkTarget(path, returnFinalTarget: false) != null;
        }
        catch (IOException)
        {
            return true;
        }
    }
}
