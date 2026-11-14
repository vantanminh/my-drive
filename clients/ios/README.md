# MyDrive iOS Client (Expo SDK 58)

Native iOS companion client for self-hosted **MyDrive** NAS servers.

## Features

- **Custom NAS URL Onboarding**: Enter any domain (`nas.example.com`), Tailscale CGNAT IP (`100.x.y.z:8080`), mDNS hostname (`mynas.local:8080`), or LAN IP (`192.168.1.50:8080`). Normalizes URLs, checks `/health/live` and `/.well-known/cloud-client`, and warns explicitly before persisting plaintext `http://` connections.
- **Session Cookie + CSRF Authentication**: Authenticates via `/api/auth/login` sharing `HttpOnly` session cookies across JS `fetch`, `expo-image`, `expo-video`, and native `URLSession.shared` transfers. Enforces temporary-password updates cleanly when required.
- **iCloud "Optimize iPhone Storage" Aware Photo Sync**: Custom local Expo Swift module (`modules/mydrive-media-sync`, backed by Apple `PhotoKit` & `CryptoKit`) inspects `PHAsset` storage state:
  - Always requests `.photo` / `.video` **original unedited** `PHAssetResource` bytes.
  - Checks `PHImageResultIsInCloudKey` with `isNetworkAccessAllowed = false`.
  - Downloads iCloud-offloaded originals directly on demand when permitted (Wi-Fi or optional cellular toggle), tracks download progress, streams SHA-256 locally, deduplicates against `/api/backup/check` + `/api/backup/link`, and uploads via resumable chunked `PATCH /api/uploads/{id}` with 409 offset resynchronization.
  - Persists per-server sync ledger in SQLite (`expo-sqlite`) and cleans temporary staging files after every transfer.
- **Photos & Albums**: 3-column cached thumbnail timeline, Albums browser & creation, full-screen swipeable viewer with pinch-to-zoom, native video playback, album tagging, NAS metadata drawer, iOS Share Sheet, and **Save Original to Photos** (`MediaLibrary.Asset.create`).
- **Files & Document Viewer**: Folder breadcrumb navigation, live search, sort toggle, multi-file upload via `expo-document-picker` with resumable chunk transfers, folder creation/renaming/trashing, and inline preview for images, videos, PDFs, Office documents, text/code files, plus native iOS QuickLook (`File.preview`).

## Local Development

```bash
cd clients/ios
npm install
npm run typecheck
npm test
npx expo prebuild --platform ios
```

A native iOS build (macOS + Xcode 16+ or GitHub Actions CI) is required to run the Swift `MyDriveMediaSync` PhotoKit/CryptoKit native module on simulator or physical iPhone.

## GitHub Actions CI/CD & Code Signing

Workflow: [`.github/workflows/ios-client.yml`](../../.github/workflows/ios-client.yml)

1. **`verify` (`ubuntu-latest`)**: Runs TypeScript checks (`npm run typecheck`), Node unit tests (`npm test`), Expo public config resolution, and iOS Metro bundle export.
2. **`ios-build-simulator` (`macos-15`)**: Runs `npx expo prebuild --platform ios --clean`, `pod install`, and compiles the generated Xcode workspace (including Swift `MyDriveMediaSync`) for iOS Simulator.
3. **`ios-sign-ipa` (`macos-15`, triggered automatically when signing secrets exist on `push` or `workflow_dispatch`)**: Imports the Apple certificate & provisioning profile into a temporary ephemeral keychain, derives Team ID / Bundle ID / export method (`development`, `ad-hoc`, or `app-store-connect`) from the `.mobileprovision` file, archives in `Release`, exports a signed `MyDrive-iOS.ipa` artifact, and optionally uploads to TestFlight.

### Required Repository Secrets for Signed `.ipa` Builds

| Secret | Description |
| --- | --- |
| `IOS_BUILD_CERTIFICATE_BASE64` | Base64-encoded Apple Distribution / Development `.p12` certificate |
| `IOS_P12_PASSWORD` | Password protecting the `.p12` file |
| `IOS_BUILD_PROVISION_PROFILE_BASE64` | Base64-encoded `.mobileprovision` profile |
| `IOS_KEYCHAIN_PASSWORD` | Password for ephemeral CI keychain (any strong random string) |

### Optional Secrets for TestFlight Upload

| Secret | Description |
| --- | --- |
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | App Store Connect API Issuer ID |
| `ASC_KEY_BASE64` | Base64-encoded `AuthKey_<KEY_ID>.p8` private key |

To trigger a tagged signed release build & publish a GitHub Release attachment:

```bash
git tag ios-v1.0.0
git push origin ios-v1.0.0
```
