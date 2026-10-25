# One-step installer (Windows).
# Copies the app to %LOCALAPPDATA%\<app>, installs Node.js if missing, downloads
# yt-dlp + ffmpeg, registers the global command and makes sure it is on the user PATH.
# The downloaded ZIP / cloned folder can be deleted afterwards.

$ErrorActionPreference = 'Stop'
$SourceDir = $PSScriptRoot
$App = (Get-Content -LiteralPath (Join-Path $SourceDir 'package.json') -Raw | ConvertFrom-Json).name
$InstallDir = Join-Path $env:LOCALAPPDATA $App
$AppItems = 'bin', 'lib', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'setup.cmd', 'setup.ps1', 'setup.sh'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    $v = (& node -v) -replace '^v', ''
    return [int]($v.Split('.')[0])
}

# 1. Node.js 20+
if ((Get-NodeMajor) -lt 20) {
    Write-Step 'Node.js 20+ not found - installing Node.js LTS...'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
        Update-SessionPath
    }
    if ((Get-NodeMajor) -lt 20) {
        Fail 'Could not install Node.js automatically. Please install Node.js 20+ from https://nodejs.org and re-run setup.'
    }
}
Write-Step "Using Node.js $(& node -v)"

# 2. Copy the app to its permanent location (keeps already-downloaded binaries in vendor\)
$src = [IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
$dst = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($src -ne $dst) {
    Write-Step "Installing $App to $InstallDir ..."
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    foreach ($item in $AppItems) {
        $from = Join-Path $SourceDir $item
        $to = Join-Path $InstallDir $item
        if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $to -Recurse -Force }
    }
    # Files from a downloaded ZIP carry the "from the internet" mark; clear it on the installed copy.
    Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
}
Set-Location -LiteralPath $InstallDir

# 3. Dependencies (yt-dlp + ffmpeg are downloaded by the postinstall script)
Write-Step 'Installing dependencies (yt-dlp, ffmpeg)...'
& npm install --no-fund --no-audit --foreground-scripts
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }

# 4. Register the global command (points at the installed copy)
Write-Step "Registering the global `"$App`" command..."
& npm install -g . --no-fund --no-audit --ignore-scripts
if ($LASTEXITCODE -ne 0) { Fail 'Global install failed.' }

# 5. Ensure npm's global bin folder is on the user PATH
$npmBin = (& npm prefix -g).Trim()
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$allPaths = "$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$userPath" -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }
if ($allPaths -notcontains $npmBin.TrimEnd('\')) {
    Write-Step "Adding $npmBin to your user PATH..."
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $npmBin } else { "$($userPath.TrimEnd(';'));$npmBin" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Update-SessionPath
}

# 6. Verify
$ver = & $App --version
if ($LASTEXITCODE -ne 0) { Fail "$App could not be started." }
Write-Host ''
Write-Host "$App v$ver is installed in $InstallDir" -ForegroundColor Green
if ($src -ne $dst) { Write-Host "You can delete $SourceDir now - it is no longer needed." }
Write-Host "Open a NEW terminal window (cmd, PowerShell, Windows Terminal, Git Bash) and run:  $App"
