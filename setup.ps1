# One-step installer for video2mp4 on Windows.
# Installs Node.js (if missing), downloads yt-dlp + ffmpeg, registers the
# global "video2mp4" command and makes sure it is on the user PATH.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

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
        Write-Host 'Could not install Node.js automatically. Please install Node.js 20+ from https://nodejs.org and re-run setup.' -ForegroundColor Red
        exit 1
    }
}
Write-Step "Using Node.js $(& node -v)"

# 2. Dependencies (yt-dlp + ffmpeg are downloaded by the postinstall script)
Write-Step 'Installing dependencies (yt-dlp, ffmpeg)...'
& npm install --no-fund --no-audit --foreground-scripts
if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed.' -ForegroundColor Red; exit 1 }

# 3. Register the global command (links this folder, so "git pull" updates it)
Write-Step 'Registering the global "video2mp4" command...'
& npm install -g . --no-fund --no-audit --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Host 'Global install failed.' -ForegroundColor Red; exit 1 }

# 4. Ensure npm's global bin folder is on the user PATH
$npmBin = (& npm prefix -g).Trim()
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$allPaths = "$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$userPath" -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }
if ($allPaths -notcontains $npmBin.TrimEnd('\')) {
    Write-Step "Adding $npmBin to your user PATH..."
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $npmBin } else { "$($userPath.TrimEnd(';'));$npmBin" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Update-SessionPath
}

# 5. Verify
$ver = & video2mp4 --version
if ($LASTEXITCODE -ne 0) { Write-Host 'video2mp4 could not be started.' -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host "video2mp4 v$ver is installed." -ForegroundColor Green
Write-Host 'Open a NEW terminal window (cmd, PowerShell, Windows Terminal, Git Bash) and run:  video2mp4'
