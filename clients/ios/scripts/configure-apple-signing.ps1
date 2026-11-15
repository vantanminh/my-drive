<#
.SYNOPSIS
  Automates Apple iOS signing setup and GitHub Actions repository secret configuration.

.DESCRIPTION
  Phase 1 (-InitOnly):
    - Generates an RSA 2048 private key (ios_dist.key) and CSR (MyDrive.certSigningRequest)
      inside gitignored <repo>/.secrets/ios-signing/.
    - Generates strong random passwords for the .p12 archive and ephemeral CI keychain.
    - Sets IOS_KEYCHAIN_PASSWORD and IOS_P12_PASSWORD on GitHub Actions via `gh secret set`.

  Phase 2 (default once .cer and .mobileprovision are placed in .secrets/ios-signing/):
    - Converts Apple's .cer certificate (DER or PEM) to PEM and verifies it matches ios_dist.key.
    - Exports a macOS Keychain compatible .p12 (3DES + SHA-1 MAC) using p12-password.txt.
    - Reads non-secret metadata from .mobileprovision (Bundle ID, Team ID, export mode).
    - Uploads IOS_BUILD_CERTIFICATE_BASE64, IOS_P12_PASSWORD,
      IOS_BUILD_PROVISION_PROFILE_BASE64, and IOS_KEYCHAIN_PASSWORD via `gh secret set`.
    - Optionally configures ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_BASE64 when an
      App Store Connect AuthKey_*.p8 file and Issuer ID are provided for TestFlight.
#>
[CmdletBinding()]
param(
  [switch]$InitOnly,
  [switch]$ForceInit,
  [switch]$TriggerCI,
  [switch]$UploadTestFlight,
  [string]$CerPath,
  [string]$ProfilePath,
  [string]$P8Path,
  [string]$AscIssuerId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RepoRoot {
  $root = (& git rev-parse --show-toplevel 2>$null)
  if (-not $root) {
    throw 'Must run inside the my-drive git repository.'
  }
  return $root.Trim()
}

function Resolve-OpenSslPath {
  $cmd = Get-Command openssl.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    'C:\Program Files\Git\usr\bin\openssl.exe',
    'C:\Program Files (x86)\Git\usr\bin\openssl.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'OpenSSL not found. Install Git for Windows or add openssl.exe to PATH.'
}

function Ensure-GhAuthenticated {
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) not found in PATH.'
  }
  & gh auth status 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI is not authenticated. Run `gh auth login` first.'
  }
}

function New-RandomSecret {
  param([int]$ByteCount = 24)
  $bytes = New-Object byte[] $ByteCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

function Write-AsciiNoNewline {
  param([string]$Path, [string]$Value)
  $encoding = New-Object System.Text.ASCIIEncoding
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Set-GitHubSecret {
  param([string]$Name, [string]$Value)
  if ($Name -notmatch '^[A-Za-z0-9_]+$') {
    throw "Invalid GitHub secret name: $Name"
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $bytes = $utf8NoBom.GetBytes($Value)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gh-secret-" + [System.Guid]::NewGuid().ToString('N') + ".bin")
  try {
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      # Redirect exact raw bytes via cmd.exe to bypass .NET StreamWriter Console.InputEncoding BOM.
      $output = & cmd.exe /d /c "gh secret set $Name < `"$tmp`"" 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevPref
    }
    if ($exitCode -ne 0) {
      throw "gh secret set $Name failed: $(($output | Out-String).Trim())"
    }
  } finally {
    if (Test-Path $tmp) {
      Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-GitHubSecretNames {
  $json = (& gh secret list --json name) | Out-String
  $items = $json | ConvertFrom-Json
  if (-not $items) { return @() }
  return @($items | ForEach-Object { $_.name })
}

function Invoke-OpenSsl {
  param([string]$OpenSslPath, [string[]]$Arguments)
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $OpenSslPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
  if ($exitCode -ne 0) {
    $joined = ($output | Out-String).Trim()
    throw "OpenSSL failed ($($Arguments -join ' ')): $joined"
  }
  return ($output | Out-String).Trim()
}

function Resolve-SingleInputFile {
  param(
    [string]$ExplicitPath,
    [string]$SigningDir,
    [string]$Pattern,
    [string]$Label
  )
  if ($ExplicitPath) {
    if (-not (Test-Path $ExplicitPath)) {
      throw "$Label not found at: $ExplicitPath"
    }
    return (Resolve-Path $ExplicitPath).Path
  }
  $matches = @(Get-ChildItem -Path $SigningDir -Filter $Pattern -File | Sort-Object LastWriteTime -Descending)
  if ($matches.Count -eq 0) { return $null }
  if ($matches.Count -gt 1) {
    $names = ($matches | ForEach-Object { $_.Name }) -join ', '
    throw "Multiple $Label files found in $SigningDir ($names). Keep only one or pass explicit path."
  }
  return $matches[0].FullName
}

function Inspect-MobileProvision {
  param([string]$ProfileFile)
  $raw = [System.IO.File]::ReadAllBytes($ProfileFile)
  $text = [System.Text.Encoding]::UTF8.GetString($raw)
  $match = [regex]::Match($text, '<plist[\s\S]*?</plist>')
  if (-not $match.Success) { return $null }

  [xml]$plist = $match.Value
  $dict = $plist.plist.dict
  $children = @($dict.ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
  $map = @{}
  for ($i = 0; $i -lt $children.Count - 1; $i += 2) {
    if ($children[$i].Name -eq 'key') {
      $map[$children[$i].InnerText] = $children[$i + 1]
    }
  }

  $teamId = ''
  if ($map.ContainsKey('ApplicationIdentifierPrefix')) {
    $firstTeam = $map['ApplicationIdentifierPrefix'].SelectSingleNode('string')
    if ($firstTeam) { $teamId = $firstTeam.InnerText }
  }

  $appId = ''
  $getTaskAllow = 'false'
  if ($map.ContainsKey('Entitlements')) {
    $entChildren = @($map['Entitlements'].ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
    for ($i = 0; $i -lt $entChildren.Count - 1; $i += 2) {
      if ($entChildren[$i].InnerText -eq 'application-identifier') {
        $appId = $entChildren[$i + 1].InnerText
      }
      if ($entChildren[$i].InnerText -eq 'get-task-allow') {
        $getTaskAllow = $entChildren[$i + 1].Name
      }
    }
  }

  $bundleId = if ($teamId -and $appId.StartsWith("$teamId.")) {
    $appId.Substring($teamId.Length + 1)
  } else {
    $appId
  }

  $hasDevices = $map.ContainsKey('ProvisionedDevices')
  $deviceCount = if ($hasDevices) { @($map['ProvisionedDevices'].SelectNodes('string')).Count } else { 0 }
  $method = if ($hasDevices) {
    if ($getTaskAllow -eq 'true') { 'development' } else { 'ad-hoc' }
  } else {
    'app-store-connect'
  }

  return [pscustomobject]@{
    Name         = if ($map.ContainsKey('Name')) { $map['Name'].InnerText } else { '' }
    TeamId       = $teamId
    BundleId     = $bundleId
    Method       = $method
    DeviceCount  = $deviceCount
    Expiration   = if ($map.ContainsKey('ExpirationDate')) { $map['ExpirationDate'].InnerText } else { '' }
  }
}

$repoRoot = Resolve-RepoRoot
$openSsl = Resolve-OpenSslPath
Ensure-GhAuthenticated

$signingDir = Join-Path $repoRoot '.secrets\ios-signing'
New-Item -ItemType Directory -Path $signingDir -Force | Out-Null

$keyPath = Join-Path $signingDir 'ios_dist.key'
$csrPath = Join-Path $signingDir 'MyDrive.certSigningRequest'
$p12PassPath = Join-Path $signingDir 'p12-password.txt'
$pemPath = Join-Path $signingDir 'ios_dist.pem'
$p12Path = Join-Path $signingDir 'mydrive_ios.p12'

if ($ForceInit -or -not (Test-Path $keyPath) -or -not (Test-Path $csrPath)) {
  Write-Host 'Generating 2048-bit RSA private key and Apple CSR...'
  Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @('genrsa', '-out', $keyPath, '2048') | Out-Null
  Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @(
    'req', '-new', '-key', $keyPath, '-out', $csrPath, '-subj', '/CN=MyDrive iOS Build'
  ) | Out-Null
} else {
  Write-Host "Reusing existing CSR & private key in $signingDir"
}

if ($ForceInit -or -not (Test-Path $p12PassPath)) {
  $p12Password = New-RandomSecret -ByteCount 24
  Write-AsciiNoNewline -Path $p12PassPath -Value $p12Password
}

$existingSecrets = @(Get-GitHubSecretNames)
if ($ForceInit -or ($existingSecrets -notcontains 'IOS_P12_PASSWORD')) {
  $p12Secret = ([System.IO.File]::ReadAllText($p12PassPath)).Trim()
  Set-GitHubSecret -Name 'IOS_P12_PASSWORD' -Value $p12Secret
  Write-Host 'Uploaded secret: IOS_P12_PASSWORD'
}

if ($ForceInit -or ($existingSecrets -notcontains 'IOS_KEYCHAIN_PASSWORD')) {
  $keychainPassword = New-RandomSecret -ByteCount 24
  Set-GitHubSecret -Name 'IOS_KEYCHAIN_PASSWORD' -Value $keychainPassword
  Write-Host 'Uploaded secret: IOS_KEYCHAIN_PASSWORD'
}

if ($InitOnly) {
  Write-Host "Init complete. Upload CSR to Apple Developer Portal: $csrPath"
  exit 0
}

$resolvedCer = Resolve-SingleInputFile -ExplicitPath $CerPath -SigningDir $signingDir -Pattern '*.cer' -Label 'Apple certificate (.cer)'
$resolvedProfile = Resolve-SingleInputFile -ExplicitPath $ProfilePath -SigningDir $signingDir -Pattern '*.mobileprovision' -Label 'Provisioning profile (.mobileprovision)'

if (-not $resolvedCer -or -not $resolvedProfile) {
  Write-Host ''
  Write-Host 'Waiting for Apple Developer Portal files in:' -ForegroundColor Yellow
  Write-Host "  $signingDir"
  if (-not $resolvedCer) {
    Write-Host "  - Missing *.cer (upload $csrPath to developer.apple.com and download the .cer file here)"
  }
  if (-not $resolvedProfile) {
    Write-Host '  - Missing *.mobileprovision (create & download the Provisioning Profile here)'
  }
  exit 0
}

# Convert Apple .cer (DER default, fallback PEM) to PEM.
try {
  Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @('x509', '-in', $resolvedCer, '-inform', 'DER', '-out', $pemPath, '-outform', 'PEM') | Out-Null
} catch {
  Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @('x509', '-in', $resolvedCer, '-inform', 'PEM', '-out', $pemPath, '-outform', 'PEM') | Out-Null
}

# Verify public key matches ios_dist.key before packaging .p12.
$certPub = Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @('x509', '-in', $pemPath, '-pubkey', '-noout')
$keyPub = Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @('pkey', '-in', $keyPath, '-pubout')
if ($certPub -ne $keyPub) {
  throw "Certificate ($resolvedCer) does not match private key ($keyPath). Ensure you uploaded $csrPath when generating the certificate."
}

# Normalize password file without trailing whitespace before OpenSSL reads it.
$cleanPass = ([System.IO.File]::ReadAllText($p12PassPath)).Trim()
Write-AsciiNoNewline -Path $p12PassPath -Value $cleanPass

# Export with PBE-SHA1-3DES + SHA-1 MAC so macOS Sequoia Keychain `security import` accepts it cleanly.
Invoke-OpenSsl -OpenSslPath $openSsl -Arguments @(
  'pkcs12', '-export',
  '-keypbe', 'PBE-SHA1-3DES',
  '-certpbe', 'PBE-SHA1-3DES',
  '-macalg', 'SHA1',
  '-inkey', $keyPath,
  '-in', $pemPath,
  '-out', $p12Path,
  '-passout', "file:$p12PassPath"
) | Out-Null

$p12Base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($p12Path))
$profileBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($resolvedProfile))

Set-GitHubSecret -Name 'IOS_P12_PASSWORD' -Value $cleanPass
Set-GitHubSecret -Name 'IOS_KEYCHAIN_PASSWORD' -Value (New-RandomSecret -ByteCount 24)
Set-GitHubSecret -Name 'IOS_BUILD_CERTIFICATE_BASE64' -Value $p12Base64
Set-GitHubSecret -Name 'IOS_BUILD_PROVISION_PROFILE_BASE64' -Value $profileBase64

$meta = Inspect-MobileProvision -ProfileFile $resolvedProfile
if ($meta) {
  Write-Host ''
  Write-Host 'Provisioning Profile Summary:' -ForegroundColor Green
  Write-Host "  Name       : $($meta.Name)"
  Write-Host "  Team ID    : $($meta.TeamId)"
  Write-Host "  Bundle ID  : $($meta.BundleId)"
  Write-Host "  Method     : $($meta.Method) ($($meta.DeviceCount) devices)"
  Write-Host "  Expires    : $($meta.Expiration)"
}

$resolvedP8 = Resolve-SingleInputFile -ExplicitPath $P8Path -SigningDir $signingDir -Pattern 'AuthKey_*.p8' -Label 'App Store Connect API Key (.p8)'
$issuerFile = Join-Path $signingDir 'asc-issuer-id.txt'
$resolvedIssuer = if ($AscIssuerId) {
  $AscIssuerId.Trim()
} elseif (Test-Path $issuerFile) {
  ([System.IO.File]::ReadAllText($issuerFile)).Trim()
} else {
  ''
}

$hasTestFlightSecrets = $false
if ($resolvedP8) {
  $p8Name = [System.IO.Path]::GetFileName($resolvedP8)
  if ($p8Name -notmatch '^AuthKey_([A-Za-z0-9]+)\.p8$') {
    throw "API key filename must match AuthKey_<KEY_ID>.p8 (got: $p8Name)"
  }
  $ascKeyId = $Matches[1]
  if (-not $resolvedIssuer) {
    throw "Found $p8Name but missing -AscIssuerId (or $issuerFile)."
  }
  Write-AsciiNoNewline -Path $issuerFile -Value $resolvedIssuer
  $p8Base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($resolvedP8))
  Set-GitHubSecret -Name 'ASC_KEY_ID' -Value $ascKeyId
  Set-GitHubSecret -Name 'ASC_ISSUER_ID' -Value $resolvedIssuer
  Set-GitHubSecret -Name 'ASC_KEY_BASE64' -Value $p8Base64
  $hasTestFlightSecrets = $true
  Write-Host "Uploaded TestFlight API key secrets (Key ID: $ascKeyId)."
} else {
  $updatedSecrets = @(Get-GitHubSecretNames)
  $hasTestFlightSecrets = ($updatedSecrets -contains 'ASC_KEY_ID') -and ($updatedSecrets -contains 'ASC_ISSUER_ID') -and ($updatedSecrets -contains 'ASC_KEY_BASE64')
}

Write-Host ''
Write-Host 'Current GitHub Actions Secrets:' -ForegroundColor Green
& gh secret list

if ($TriggerCI) {
  Write-Host ''
  $shouldUploadTf = $UploadTestFlight -or ($hasTestFlightSecrets -and $meta -and $meta.Method -eq 'app-store-connect')
  if ($shouldUploadTf) {
    Write-Host 'Triggering iOS Client (Expo) workflow with upload_testflight=true...'
    & gh workflow run ios-client.yml -f upload_testflight=true
  } else {
    Write-Host 'Triggering iOS Client (Expo) workflow...'
    & gh workflow run ios-client.yml
  }
}
