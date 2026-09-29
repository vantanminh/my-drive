; Per-user installer. Tokens live in the installing user's DPAPI store, so the
; app is installed under that user's profile and does not ask for administrator rights.
#ifndef AppVersion
#define AppVersion "1.0.0"
#endif
#ifndef PublishDir
#define PublishDir "..\publish\win-x64"
#endif
#ifndef OutputDir
#define OutputDir "..\dist"
#endif

[Setup]
AppId={{8F4E2A71-6C3B-4D19-9A55-7B1E0C4D2F90}
AppName=My Drive Backup
AppVersion={#AppVersion}
AppPublisher=My Drive
DefaultDirName={localappdata}\Programs\My Drive Backup
DefaultGroupName=My Drive Backup
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=MyDriveBackup-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\MyDrive.Backup.exe
UninstallDisplayName=My Drive Backup
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\My Drive Backup"; Filename: "{app}\MyDrive.Backup.exe"

[Run]
Filename: "{app}\MyDrive.Backup.exe"; Description: "Launch My Drive Backup"; Flags: nowait postinstall skipifsilent
