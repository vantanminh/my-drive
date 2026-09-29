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

## Build

The backup engine and the background agent target `net8.0` and can be tested on Linux:

```bash
dotnet test clients/windows/MyDrive.Backup.sln
```

The tray app targets `net8.0-windows` and is built on Windows:

```bash
dotnet build clients/windows/MyDrive.Backup.Windows.sln -c Release
```

Publish the agent and the app into the same folder. The agent is a Windows GUI binary: starting it does not open a command window. The app launches `MyDrive.Backup.Agent.exe` with no window if nothing is answering the `MyDrive.Backup` pipe, and it replaces an agent that stays up without answering. Closing the window leaves the agent running. **Start with Windows** registers the agent for the current user. `--install-service` is an optional `sc.exe` registration and must not be combined with a second copy of the agent. Service output is written to `%LocalAppData%\MyDriveBackup\agent.log`.

HTTP is rejected unless you explicitly allow an insecure development or LAN URL. Certificate validation stays enabled.
