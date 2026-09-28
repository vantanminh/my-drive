using System.Text.Json;

namespace MyDrive.Backup;

public static class JsonOpts
{
    public static readonly JsonSerializerOptions Store = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
    };
}
