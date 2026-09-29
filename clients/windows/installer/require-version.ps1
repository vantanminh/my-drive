# Fails the build when client files changed but <Version> was not bumped.
$ErrorActionPreference = 'Stop'

$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Resolve-Path (Join-Path $installerDir '..')
$props = Get-Content -Raw -Path (Join-Path $windowsDir 'Directory.Build.props')
if ($props -notmatch '<Version>(\d+\.\d+\.\d+)</Version>') {
    throw 'clients/windows/Directory.Build.props is missing a numeric <Version>.'
}

$version = $Matches[1]
$tag = "windows-client-v$version"
Write-Host "Client version $version"
$nativeErrors = $PSNativeCommandUseErrorActionPreference
$PSNativeCommandUseErrorActionPreference = $false
try {
    git fetch origin "refs/tags/${tag}:refs/tags/${tag}" --depth=1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tag $tag is not published yet, so this version can be released."
        exit 0
    }

    git diff --quiet $tag HEAD -- clients/windows
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Client files match $tag."
        exit 0
    }
}
finally {
    $PSNativeCommandUseErrorActionPreference = $nativeErrors
}

throw "Client files changed since $tag. Bump <Version> in clients/windows/Directory.Build.props before publishing a new client."
