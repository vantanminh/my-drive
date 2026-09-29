# Windows Backup Client

This is the desktop backup agent for a self-hosted My Drive server. It is part of this repository, not a separate cloud. The app asks for your server URL, opens that server's `/device/authorize` page in the browser, and then watches the folders you choose.

There is no built-in hostname and no password field. Access and refresh tokens stay in Windows DPAPI. On a non-Windows build machine the same engine uses an AES-GCM file instead, and the tests use an in-memory store. Tokens are not written to SQLite or to the log.

## What it does

- Discovers `GET /.well-known/cloud-client` and speaks API version `1` only.
- Signs in with the OAuth device-code flow. Revoke the computer from **Account security → Backup devices**.
- Watches folders continuously, or runs hourly, daily, weekly, every few minutes, or when you press **Backup Now**.
- Skips a file when its size and modified time are unchanged. If the content hash is already on the server, the bytes are linked instead of uploaded.
- Uploads with the server's offset resume API, in chunks of 8–64 MiB, and continues after the app, the network, or Windows restarts.
- Keeps the cloud copy when a local file disappears unless the job's deletion policy says otherwise. Removing a job does not delete remote files.

The protocol is documented at `/docs/backup-client.md`.

## Install

On Windows, download `MyDriveBackup-Setup.exe` from the GitHub Release named **Windows Backup Client** and run it. That file is built by GitHub Actions for every push to `master` and for version tags. It installs for the current user, creates a Start menu shortcut, and does not require a separate .NET install. Windows may show an unknown-publisher warning because the installer is not code-signed.

Pull requests upload the same installer as the `MyDriveBackup-Setup` workflow artifact so the package can be tried before it is released.

## Build

The backup engine and the background agent target `net8.0` and can be tested on Linux:

```bash
dotnet test clients/windows/MyDrive.Backup.sln
```

The tray app targets `net8.0-windows` and is built on Windows:

```bash
dotnet build clients/windows/MyDrive.Backup.Windows.sln -c Release
```

Publish puts the app in `publish/win-x64` and the agent, with its own runtime, in `publish/win-x64/agent`. The agent is a Windows GUI binary: starting it does not open a command window. The app launches `agent\MyDrive.Backup.Agent.exe` with no window if nothing is answering the `MyDrive.Backup` pipe. If that process exits or never listens, the app runs the same service itself. Closing the window leaves a separate agent running. **Start with Windows** registers the agent for the current user. `--install-service` is an optional `sc.exe` registration and must not be combined with a second copy of the agent. Service output is written to `%LocalAppData%\MyDriveBackup\agent.log`.

HTTP is rejected unless you explicitly allow an insecure development or LAN URL. Certificate validation stays enabled.
