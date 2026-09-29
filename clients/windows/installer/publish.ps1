# Publishes the self-contained Windows app and agent, then builds MyDriveBackup-Setup.exe.
$ErrorActionPreference = 'Stop'

$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Resolve-Path (Join-Path $installerDir '..')
$publish = Join-Path $windowsDir 'publish\win-x64'
$agentPublish = Join-Path $publish 'agent'
$dist = Join-Path $windowsDir 'dist'
$propsPath = Join-Path $windowsDir 'Directory.Build.props'
$props = Get-Content -Raw -Path $propsPath
if ($props -notmatch '<Version>(\d+\.\d+\.\d+)</Version>') {
    throw "clients/windows/Directory.Build.props is missing a numeric <Version>."
}
$version = $Matches[1]

if (Test-Path $publish) {
    Remove-Item -Recurse -Force $publish
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null

if ($env:GITHUB_ENV) {
    "CLIENT_VERSION=$version" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8NoBOM
}

Write-Host "Publishing My Drive Backup $version"
dotnet publish (Join-Path $windowsDir 'src\MyDrive.Backup.App\MyDrive.Backup.App.csproj') `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $publish `
    -p:DebugType=none `
    -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Own folder on purpose. A single-file agent copied beside the self-contained app
# loads that app's hostfxr.dll and exits before it can listen.
dotnet publish (Join-Path $windowsDir 'src\MyDrive.Backup.Agent\MyDrive.Backup.Agent.csproj') `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $agentPublish `
    -p:DebugType=none `
    -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $publish 'MyDrive.Backup.exe'))) {
    throw 'The desktop app was not published.'
}
if (-not (Test-Path (Join-Path $agentPublish 'MyDrive.Backup.Agent.exe'))) {
    throw 'The backup agent was not published in its own folder.'
}
if (-not (Test-Path (Join-Path $agentPublish 'hostfxr.dll'))) {
    throw 'The backup agent was published without its own runtime.'
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
