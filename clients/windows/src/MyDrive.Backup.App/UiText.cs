using System.Globalization;

namespace MyDrive.Backup.App;

public static class UiText
{
    private static readonly Dictionary<string, (string En, string Vi)> Strings = new()
    {
        ["dashboard"] = ("Dashboard", "Tổng quan"),
        ["backups"] = ("Backups", "Sao lưu"),
        ["transfers"] = ("Transfers", "Truyền tải"),
        ["activity"] = ("Activity", "Hoạt động"),
        ["settings"] = ("Settings", "Cài đặt"),
        ["account"] = ("Account", "Tài khoản"),
        ["server"] = ("Server", "Máy chủ"),
        ["storage"] = ("Storage", "Dung lượng"),
        ["protected"] = ("Protected folders", "Thư mục được bảo vệ"),
        ["files"] = ("Files backed up", "Tệp đã sao lưu"),
        ["backupSize"] = ("Backup size", "Dung lượng sao lưu"),
        ["last"] = ("Last backup", "Lần sao lưu gần nhất"),
        ["uploading"] = ("Uploading", "Đang tải lên"),
        ["speed"] = ("Speed", "Tốc độ"),
        ["remaining"] = ("Remaining", "Còn lại"),
        ["eta"] = ("Estimated time", "Thời gian ước tính"),
        ["unlimited"] = ("Unlimited", "Không giới hạn"),
        ["backupNow"] = ("Backup Now", "Sao lưu ngay"),
        ["pause"] = ("Pause Backup", "Tạm dừng"),
        ["resume"] = ("Resume backups", "Tiếp tục"),
        ["addFolder"] = ("Add folder", "Thêm thư mục"),
        ["open"] = ("Open Dashboard", "Mở tổng quan"),
        ["exit"] = ("Exit", "Thoát"),
        ["connect"] = ("Connect to your server", "Kết nối máy chủ của bạn"),
        ["test"] = ("Test connection", "Kiểm tra kết nối"),
        ["signIn"] = ("Continue in browser", "Tiếp tục trên trình duyệt"),
        ["authorized"] = ("Device authorized", "Thiết bị đã được ủy quyền"),
        ["waitingApproval"] = ("Approve this device in the browser. This window updates when approval finishes.", "Hãy phê duyệt thiết bị trên trình duyệt. Cửa sổ này sẽ tự cập nhật khi phê duyệt xong."),
        ["userCode"] = ("User code", "Mã thiết bị"),
        ["choose"] = ("Choose folders to protect", "Chọn thư mục cần bảo vệ"),
        ["ready"] = ("You're protected.", "Dữ liệu đã được bảo vệ."),
        ["start"] = ("Start backup", "Bắt đầu sao lưu"),
        ["insecure"] = ("Insecure connection", "Kết nối không an toàn"),
        ["changeServer"] = ("Change server", "Đổi máy chủ"),
        ["disconnect"] = ("Log out / Disconnect server", "Đăng xuất / Ngắt máy chủ"),
        ["all"] = ("All", "Tất cả"),
        ["uploaded"] = ("Uploaded", "Đã tải lên"),
        ["skipped"] = ("Skipped", "Bỏ qua"),
        ["failed"] = ("Failed", "Thất bại"),
        ["deleted"] = ("Deleted", "Đã xóa"),
    };

    public static string Language { get; set; } = "auto";

    public static string Get(string key)
    {
        if (!Strings.TryGetValue(key, out var value))
        {
            return key;
        }

        var vietnamese = Language == "vi" || (Language == "auto" && CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "vi");
        return vietnamese ? value.Vi : value.En;
    }
}
