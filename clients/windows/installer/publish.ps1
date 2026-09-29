# Publishes the self-contained Windows app and agent, then builds MyDriveBackup-Setup.exe.
$ErrorActionPreference = 'Stop'

$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Resolve-Path (Join-Path $installerDir '..')
$publish = Join-Path $windowsDir 'publish\win-x64'
$agentPublish = Join-Path $windowsDir 'publish\win-x64-agent'
$dist = Join-Path $windowsDir 'dist'
$clientInfo = Join-Path $windowsDir 'src\MyDrive.Backup.Core\ClientInfo.cs'
$version = '1.0.0'
$info = Get-Content -Raw -Path $clientInfo
if ($info -match 'Version = "([^"]+)"') {
    $version = $Matches[1]
}

if (Test-Path $publish) {
    Remove-Item -Recurse -Force $publish
}
if (Test-Path $agentPublish) {
    Remove-Item -Recurse -Force $agentPublish
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Write-Host "Publishing My Drive Backup $version"
dotnet publish (Join-Path $windowsDir 'src\MyDrive.Backup.App\MyDrive.Backup.App.csproj') `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $publish `
    -p:DebugType=none `
    -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

dotnet publish (Join-Path $windowsDir 'src\MyDrive.Backup.Agent\MyDrive.Backup.Agent.csproj') `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $agentPublish `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:DebugType=none `
    -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item (Join-Path $agentPublish 'MyDrive.Backup.Agent.exe') (Join-Path $publish 'MyDrive.Backup.Agent.exe') -Force
if (-not (Test-Path (Join-Path $publish 'MyDrive.Backup.exe'))) {
    throw 'The desktop app was not published.'
}
if (-not (Test-Path (Join-Path $publish 'MyDrive.Backup.Agent.exe'))) {
    throw 'The backup agent was not published next to the desktop app.'
}

$isccCandidates = @()
if ($env:INNO_SETUP) {
    $isccCandidates += (Join-Path $env:INNO_SETUP 'ISCC.exe')
}
$isccCandidates += @(
    'C:\InnoSetup6\ISCC.exe',
    (Join-Path ${env:ProgramFiles} 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    throw 'Inno Setup 6 was not found. Install it, then run this script again.'
}

$publishArg = ($publish -replace '\\', '/')
$distArg = ($dist -replace '\\', '/')
& $iscc "/DAppVersion=$version" "/DPublishDir=$publishArg" "/DOutputDir=$distArg" (Join-Path $installerDir 'MyDriveBackup.iss')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$setup = Join-Path $dist 'MyDriveBackup-Setup.exe'
if (-not (Test-Path $setup)) {
    throw 'The installer was not created.'
}
Write-Host "Installer ready: $setup"
