# Cài My Drive lên Ubuntu VPS

Mỗi bản cài có tài khoản chủ sở hữu, mật khẩu database, dữ liệu và cấu hình riêng.
Lệnh cài nhanh tải image đã build bởi GitHub CI/CD; không clone hoặc build
Rust/frontend trên VPS. Có thể dùng image từ CI của fork/registry riêng. Không cần tài
khoản của tác giả, GHCR, Cloudflare, Firebase hoặc Google để chạy drive.
Google Drive import chỉ hoạt động khi bạn chủ động cấu hình OAuth của mình.

## 1. Chuẩn bị VPS

- Ubuntu 22.04, 24.04 hoặc 26.04, systemd, quyền `sudo`.
- Build tại VPS: tối thiểu 4 GiB RAM; nên có 2 vCPU và ít nhất 20 GiB trống cho
  Docker build, ngoài dung lượng lưu file. Dùng image tự build ở máy khác:
  tối thiểu 2 GiB RAM; tính thêm RAM nếu bật indexing hoặc chuyển đổi tài liệu.
- Filesystem bền vững ext4, XFS hoặc Btrfs có UUID. Bộ cài không format, chia
  partition, tự mount hay sửa `/etc/fstab`. Với ổ dữ liệu riêng, mount bằng UUID
  trước khi chạy bộ cài. Chọn thư mục con trống trên ổ đó.
- Với HTTPS công khai: có tên miền trỏ A record về IP VPS; nếu có AAAA record,
  IPv6 phải truy cập được VPS. Cho phép TCP 80/443 trong firewall nhà cung cấp
  và firewall máy; giữ cổng SSH đang dùng. Hai cổng phải chưa có dịch vụ khác chiếm.
- Bộ cài không tự bật UFW hoặc thay SSH để tránh làm mất quyền truy cập. Chỉ
  reverse proxy mở 80/443; database, app và converter không mở cổng public.
- Kết nối Internet để tải package, base image, Rust/npm dependencies. Có thể
  dùng mirror/registry do bạn quản lý; chạy thường ngày không gọi dịch vụ của tác giả.

## Cài nhanh: một lệnh, không clone và không build

Trên Ubuntu **amd64**, chạy:

```bash
sudo bash -c 'set -e; apt-get update; apt-get install -y ca-certificates curl; curl -fsSL https://raw.githubusercontent.com/vantanminh/my-drive/master/scripts/bootstrap.sh | bash'
```

Bootstrap tải Compose và scripts triển khai vào thư mục tạm, cài Docker,
chạy wizard và pull app/document-preview/indexer từ GHCR. Không tải source
Rust, frontend hoặc Dockerfile. Thư mục tạm được xóa khi kết thúc; file runtime
được giữ trong `/opt/my-drive`. Image sau pull được ghim theo digest.
Wizard đọc trực tiếp terminal nên vẫn dùng được dù bootstrap chạy qua pipe.

GitHub CI cần publish đủ các image và package phải là **Public** để người cài
không cần tài khoản GitHub. Repository public không tự làm package public.
Chủ repo đặt visibility của từng package ở GitHub Packages sau lần publish đầu;
nếu GHCR trả 403/denied, kiểm tra bước này và trạng thái workflow `Docker images`.
Bootstrap chỉ hỗ trợ amd64 theo kiến trúc image mà CI hiện publish, và không
fallback sang build tại VPS nếu pull thất bại.

Để dùng fork hoặc release cụ thể, tải bootstrap thành file và truyền cấu hình:

```bash
curl -fsSL https://raw.githubusercontent.com/vantanminh/my-drive/master/scripts/bootstrap.sh -o /tmp/my-drive-bootstrap.sh
sudo env MY_DRIVE_REPOSITORY=your-name/my-drive MY_DRIVE_REF=v1.2.3 \
  MY_DRIVE_IMAGE_PREFIX=ghcr.io/your-name/my-drive MY_DRIVE_IMAGE_TAG=v1.2.3 \
  bash /tmp/my-drive-bootstrap.sh
```

Chọn cùng release cho ref scripts và tag images. Với nhánh `master`, mặc định
image tag là `latest`; đợi CI publish xong trước khi cài. Ref chấp nhận branch
không chứa `/`, tag hoặc commit. `MY_DRIVE_IMAGE_PREFIX` cho phép registry riêng.
Private registry vẫn cần `sudo docker login` như hướng dẫn bên dưới.

Nếu muốn tự kiểm tra source rồi **chủ động build tại VPS**, dùng cách thay thế:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/vantanminh/my-drive.git
cd my-drive
# Nếu đã có release mong muốn: git checkout <tag-hoặc-commit>
sudo bash scripts/install.sh  # local build; không phải cách cài nhanh phía trên
```

Script sử dụng repository APT có khóa ký của Docker để cài Engine/Compose khi
chưa có Docker. Nếu có runtime xung đột, script dừng để bạn tự chuyển đổi; không
gỡ các dịch vụ đang dùng. Nếu Docker đã có nhưng thiếu Compose plugin, cài
plugin tương ứng rồi chạy lại. Không cần Node/Rust trên host vì build trong Docker.

## 2. Trả lời wizard

Wizard hỏi tên miền hoặc IPv4, chế độ TLS, email chủ sở hữu, mật khẩu, thư mục
dữ liệu, indexing và giới hạn lưu trữ. Mật khẩu không hiện khi nhập; bỏ trống
để tạo ngẫu nhiên. Email chủ sở hữu không bắt buộc có SMTP để đăng nhập; khi
dùng ACME nó cũng là email liên hệ CA.

| Lựa chọn | Cách hoạt động |
| --- | --- |
| `media_indexing=false` | VPS một filesystem; tắt cache ảnh/video và face indexing. Upload, download, share, tài khoản và document preview vẫn chạy. |
| `media_indexing=true` | Cache preview phải nằm trên filesystem khác với dữ liệu gốc. PostgreSQL có thể cùng filesystem với cache. Bộ cài kiểm tra UUID và ứng dụng kiểm tra device của bind mount. |
| `tls=acme` | Tên miền công khai; Caddy xin và gia hạn chứng chỉ tự động qua CA công khai. |
| `tls=internal` | IP hoặc tên miền nội bộ; Caddy tạo CA trên VPS. Bạn tự cài public root certificate vào thiết bị truy cập. Không cần CA bên ngoài. |

Với một ổ đĩa, thư mục preview trống vẫn được mount read-only vào app để dùng
chung định dạng backup/restore; app không được cấu hình dùng cache này.
`STORAGE_REQUIRE_MOUNT` và kiểm tra device luôn bật. Bộ cài chấp nhận dữ liệu
trên filesystem gốc của VPS thông qua bind mount đã xác minh; cấu hình Compose
thủ công trong README vẫn dành cho mô hình HDD/SSD riêng.

Các thư mục data phải trống ở lần cài mới và không được chồng nhau hoặc dùng
symlink. Với mặc định, chúng là `/srv/my-drive/data`,
`/var/lib/my-drive/postgres`, `/var/lib/my-drive/previews`. Nếu ổ được mount
tại `/mnt/data`, hãy chọn `/mnt/data/my-drive`, không dùng gốc ổ có `lost+found`.
Quota mặc định 100 GiB là giới hạn tài khoản, không đặt trước dung lượng ổ.
`min_free_gib` mặc định 5: ứng dụng có thể từ chối upload nếu không còn đủ trống.
Trash quá số ngày cấu hình được xóa vĩnh viễn bởi maintenance worker.

Sau khi hoàn tất:

```bash
sudo my-drive status
sudo cat /opt/my-drive/owner-credentials.txt
```

Đăng nhập tại URL in ra, lưu mật khẩu vào password manager, rồi xóa bản plaintext:

```bash
sudo rm /opt/my-drive/owner-credentials.txt
```

Ứng dụng bootstrap chủ sở hữu trước khi mở proxy. Khi readiness thành công,
bộ cài xóa hai biến bootstrap khỏi env/state và tạo lại container app. Container
runtime không giữ mật khẩu chủ sở hữu. Không có mật khẩu hoặc tài khoản mặc định.

Với CA nội bộ, lấy **public certificate** sau khi cài:

```bash
sudo cat /opt/my-drive/caddy-data/caddy/pki/authorities/local/root.crt
```

Chuyển certificate này qua SSH, kiểm tra fingerprint và thêm vào trust store
của máy/browser truy cập. Không chuyển `root.key`; đó là private key của CA.
Trình duyệt chưa tin CA sẽ cảnh báo, dù kiểm tra HTTPS của bộ cài đã thành công
bằng public root certificate trên VPS. Cookie phiên luôn dùng `Secure`.

## 3. Cài không tương tác hoặc dùng registry riêng

Copy mẫu ra ngoài repo và đặt quyền riêng tư **trước khi** thêm mật khẩu:

```bash
umask 077
curl -fsSL https://raw.githubusercontent.com/vantanminh/my-drive/master/deploy/vps.example.json -o /tmp/my-drive-setup.json
nano /tmp/my-drive-setup.json
curl -fsSL https://raw.githubusercontent.com/vantanminh/my-drive/master/scripts/bootstrap.sh -o /tmp/my-drive-bootstrap.sh
sudo bash /tmp/my-drive-bootstrap.sh --config /tmp/my-drive-setup.json
rm /tmp/my-drive-setup.json
```

Đổi `host`, `email`, TLS và các path. Có thể thêm `owner_password` dài ít nhất
16 byte hoặc bỏ trường đó để tạo ngẫu nhiên. Không đặt secret vào command line,
repo, shell history hoặc biến CI công khai. Các giá trị dung lượng tính theo GiB.
Field lạ, boolean sai kiểu, path nguy hiểm và cấu hình TLS sai đều bị từ chối.

Với bootstrap hoặc `scripts/install.sh --prebuilt`, `images: {}` nghĩa là tải
image CI đã publish, không build. Nếu chạy `scripts/install.sh` từ checkout
không có `--prebuilt`, mapping trống mới có nghĩa là build source.
Để dùng image của riêng bạn, cung cấp:

```json
"images": {
  "app": "registry.example.com/my-drive:v1",
  "document-preview": "registry.example.com/my-drive-document-preview:v1"
}
```

Nếu bật indexing, thêm `media-indexer`. Dùng cùng release cho các target.
Bạn có thể build Dockerfile targets `runtime`, `document-preview-runtime`,
`media-indexer-runtime` trên máy build rồi push registry của mình. Khi dùng
registry private, đăng nhập Docker trong ngữ cảnh root trước khi cài:
`sudo docker login registry.example.com`. Nên dùng digest `@sha256:...` để giữ
đúng artifact. Base PostgreSQL/Caddy vẫn tải từ Docker Hub theo mặc định.

## 4. File cấu hình và vận hành

`/opt/my-drive` chỉ root truy cập. Nó chứa `.env`, `state.json`, Compose,
Caddyfile, TLS state và scripts runtime. Có thể xóa checkout source sau khi cài;
hãy giữ một checkout đã review khi muốn build phiên bản mới.
Không đưa `/opt/my-drive` hoặc data vào Git. `state.json` chứa database secret;
đây là cấu hình riêng, không phải file để chia sẻ.

```bash
sudo my-drive check               # UUID và vị trí mount; cập nhật major:minor khi reboot
sudo my-drive status
sudo my-drive logs app            # 100 dòng gần nhất; có thể chọn proxy/db/media-indexer
sudo systemctl stop my-drive      # dừng cả stack
sudo systemctl start my-drive
sudo systemctl restart my-drive
sudo journalctl -u my-drive -n 100 --no-pager
```

Systemd tự khởi động sau reboot, đợi Docker/network/mount rồi kiểm tra UUID
của cả database, dữ liệu và cache trước khi chạy. Nếu mất ổ hoặc mount sai,
startup dừng; không tự tạo thư mục thay thế. Container dùng `on-failure:5` để
thử lại lỗi tiến trình, không tự khởi động bởi Docker daemon trước bước kiểm tra
mount của systemd. Log Docker được xoay vòng 3 file, mỗi file tối đa 10 MiB.

Chạy lại `sudo bash scripts/install.sh` từ checkout để tiếp tục lần cài chưa
hoàn tất. Khi có state, bộ cài sử dụng cấu hình cũ, không reset tài khoản/data.
Không truyền `--config` trong lần chạy tiếp này. Nếu build ban đầu thất bại
trước khi tạo state, sửa nguyên nhân và thử lại; không cần xóa data.
Nếu `/opt/my-drive` có file nhưng chưa có state, bộ cài dừng để tránh ghi đè.
Kiểm tra file còn lại, chuyển chúng sang nơi lưu giữ rồi mới thử lại.

Google Drive import là tùy chọn sau khi cài: tạo OAuth client của riêng bạn,
đặt cả bốn biến `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_DRIVE_TOKEN_KEY` trong mapping `env` của
`/opt/my-drive/state.json` bằng editor root. Redirect dùng
`https://<host>/api/google-drive/callback`; token key là 64 ký tự hex ngẫu nhiên
(`openssl rand -hex 32`). Restart dịch vụ để bộ cài ghi `.env` từ state. Đừng
chỉ sửa `.env` vì lần start tiếp sẽ ghi lại nó. Phần quản lý giới hạn/tài khoản
thành viên thực hiện trong giao diện chủ sở hữu.

## 5. Backup mã hóa

Chuẩn bị disk/NAS mount backup trên filesystem **khác** với tất cả data root.
Tạo age identity ở máy an toàn và giữ private identity bên ngoài VPS. Dùng
`age-keygen -y /path/to/identity` để lấy public recipient. Truyền recipient cho VPS:

```bash
sudo my-drive backup --backup-root /mnt/backup/my-drive --recipient age1...
```

Backup tạm dừng app/indexer để giữ database/file nhất quán, sau đó khởi động
lại nếu trước đó đang chạy. Output có bundle ứng dụng và file companion
`my-drive-<id>.deployment.tar.age`. Giữ **cả hai**. Companion mã hóa cấu hình
installer, database secrets, scripts và private TLS/CA keys. Không tự tạo
private age identity trên VPS và không dùng ổ dữ liệu làm ổ backup.
Copy backup sang nơi ngoài VPS, kiểm tra và diễn tập restore định kỳ. Chưa có
backup hợp lệ thì không coi một ổ đĩa là phương án khôi phục.

Để verify bundle, truyền path Compose/env của bản cài và private identity đã
đưa lên máy khôi phục an toàn:

```bash
sudo env APP_ENV_FILE=/opt/my-drive/.env \
  COMPOSE_FILE_PATH=/opt/my-drive/compose.yaml COMPOSE_PROJECT_NAME=my-drive \
  AGE_IDENTITY=/root/recovery/identity \
  /opt/my-drive/scripts/verify-backup.sh /mnt/backup/my-drive/my-drive-<id>
```

Trước restore, dừng systemd để thao tác không chạy đua với lifecycle. Cho DB
chạy, xác nhận đúng target rồi dùng script có sẵn:

```bash
sudo systemctl stop my-drive
sudo docker compose --env-file /opt/my-drive/.env \
  -f /opt/my-drive/compose.yaml -p my-drive up -d db
sudo env APP_ENV_FILE=/opt/my-drive/.env \
  COMPOSE_FILE_PATH=/opt/my-drive/compose.yaml COMPOSE_PROJECT_NAME=my-drive \
  AGE_IDENTITY=/root/recovery/identity CONFIRM_RESTORE_DB=my-drive/mydrive \
  /opt/my-drive/scripts/restore.sh /mnt/backup/my-drive/my-drive-<id>
sudo systemctl start my-drive
```

Script restore xác minh checksums, archive paths và dump; giữ bản data/database
cũ để xử lý lỗi. Đọc thêm phần [Encrypted backup and restore](../README.md#encrypted-backup-and-restore)
trước khi dùng. Restore ghi đè dữ liệu live; chạy diễn tập trên VPS/ổ riêng.

Khôi phục toàn VPS: giải mã companion vào **thư mục staging root-only**, kiểm
tra file, lấy cấu hình/secret cần thiết; không giải nén đè thẳng `/`. Lấy cùng
release source/image với backup và tạo config cho data directories trống,
cùng loại storage profile trên máy mới:

```bash
sudo bash scripts/install.sh --config /root/recovery/setup.json --prepare-only
```

Bước này build/pull và tạo cấu hình, nhưng chưa tạo DB hoặc bật dịch vụ. Trong
`state.json` mới, giữ nguyên paths/UUID vừa phát hiện; thay `POSTGRES_PASSWORD`,
`MEDIA_INDEXER_PASSWORD` và các giá trị Google OAuth/token key bằng giá trị từ
state backup. Xóa giá trị hai biến `BOOTSTRAP_OWNER_*` vì tài khoản sẽ khôi phục
từ database. Chạy `sudo my-drive check` để ghi `.env`. Nếu muốn giữ CA nội bộ
cũ, chuyển `caddy-data` từ staging trước khi start; nếu tạo CA mới phải cập nhật
trust store client. Tạo ba thư mục trống `objects`, `uploads`, `trash` bên trong
storage root, chủ sở hữu UID/GID 10001 và quyền 700, để script restore có thể
kiểm tra đích. Start riêng `db` và chạy restore như ví dụ trên, rồi dùng
`sudo systemctl enable --now my-drive`. Xóa file owner credentials tạm vì đó
không phải mật khẩu của tài khoản đã restore. Companion không chứa dữ liệu
PostgreSQL/file gốc; chúng nằm trong bundle.

## 6. Cập nhật và rollback

Với bản cài dùng image registry (bao gồm bootstrap một lệnh), chạy:

```bash
sudo my-drive update
```

VPS cài trước khi có chế độ một lệnh cần tải và chạy lại bootstrap từ release
mới một lần để làm mới script quản trị trong `/opt/my-drive`; dùng cùng
repository/ref tùy chỉnh nếu có và không truyền `--config`. Trạng thái cài đặt,
database và file không bị tạo lại.

Lệnh pull lại các image reference đã cấu hình khi cài, ghim digest mới, tạo
backup ứng dụng và cấu hình được mã hóa, áp dụng image rồi kiểm tra readiness
và HTTPS. Lần đầu có bản mới, lệnh hỏi thư mục backup trên filesystem riêng và
age public recipient; sau backup thành công hai giá trị được lưu trong
`/opt/my-drive/state.json` để những lần sau không cần nhập lại. Chỉ lưu public
recipient trên VPS; giữ private identity ở nơi an toàn ngoài VPS. Nếu image
digest chưa đổi, lệnh báo đã mới nhất và không restart dịch vụ hay tạo backup.

Lệnh theo đúng tag/digest đang cấu hình. Tag di động như mặc định `latest` sẽ
nhận image mới sau khi CI publish; tag phiên bản cố định hoặc digest sẽ giữ
phiên bản đó. Để chuyển release hoặc registry, dùng lệnh có tham số bên dưới.

Để build từ checkout đã review:

```bash
sudo my-drive update --source /path/to/reviewed-checkout \
  --backup-root /mnt/backup/my-drive --recipient age1...
```

Hoặc ghi JSON mapping `app`/`document-preview`/`media-indexer` vào file riêng và dùng
`--images /path/to/release-images.json` thay `--source`. Có thể truyền
`--backup-root` và `--recipient` để đổi nơi backup hoặc recipient; cấu hình mới
được lưu sau khi backup thành công. Cập nhật build/pull image trước khi dừng app,
tạo backup mã hóa đầy đủ, lưu image references cũ trong `state.previous.json`,
áp dụng image mới rồi kiểm tra readiness và HTTPS.
Không tự `git pull`, không tự nâng database major version, không tự cập nhật
mã installer/Compose layout sang schema mới. Thay đổi topology ở release sau
cần đọc migration guide và chạy bộ cài tương ứng có hỗ trợ migration.

Nếu cập nhật lỗi, data không bị xóa. Xem logs và giữ backup. Không tự chạy
image cũ trên database đã migration. Để rollback: stop systemd, giữ nguyên
database password hiện tại, lấy các `MY_DRIVE_*_IMAGE` từ `state.previous.json`
đưa vào `state.json`, khôi phục bundle trước update theo bước restore ở trên,
rồi start. Giữ lại local images cũ; không chạy prune trước khi xác nhận release.

## 7. Gỡ dịch vụ hoặc xử lý lỗi

Để ngừng dùng và giữ dữ liệu:

```bash
sudo systemctl disable --now my-drive
```

Bộ cài không có lệnh xóa data tự động. Sau khi đã kiểm tra backup, bạn tự quyết
định xóa container, cấu hình hay dữ liệu nào. Không gỡ Docker nếu VPS còn ứng
dụng khác sử dụng nó.

| Triệu chứng | Kiểm tra |
| --- | --- |
| HTTPS không lên | `my-drive logs proxy`; DNS A/AAAA, TCP 80/443, firewall, dịch vụ đang chiếm cổng, rate limit ACME. |
| App không ready | `my-drive logs app`, `logs db`; quota/free space, mount UUID, quyền UID 10001. |
| indexing không chạy | Cần bật profile từ lần cài đầu; preview phải khác filesystem; `logs media-indexer-db-setup` và `logs media-indexer`. |
| Reboot không lên | `journalctl -u my-drive`, `findmnt`, `/etc/fstab`; khôi phục đúng mount rồi start lại. |
| Backup bị từ chối | Destination phải tồn tại trên filesystem khác; recipient hợp lệ; app/db đang chạy. |

## Kiểm chứng và nguồn kỹ thuật

Chạy `python3 -B -m unittest discover -s tests -p test_vps_installer.py -v` và
`bash -n scripts/install.sh`. CI Ubuntu chạy cùng checks, gồm phân giải bằng
Docker Compose thật, secrets có ký tự đặc biệt, kiểm tra mất mount và thứ tự
gỡ bootstrap trước proxy. Workflow `VPS installer checks` có job smoke Ubuntu
24.04 chạy khi chọn `Run workflow`: pull image CI, cài stack thật với CA nội bộ,
restart systemd và kiểm tra bootstrap đã gỡ. Các checks này chưa thay thế một lần cài/reboot/restore
trên VPS thật; hãy dùng staging trước khi đưa dữ liệu quan trọng vào.

Quy trình repository APT theo [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
TLS tự động và CA nội bộ theo [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
và [Caddy TLS directive](https://caddyserver.com/docs/caddyfile/directives/tls).
