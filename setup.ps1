# Windows installer. Dot-source to load the helpers without installing.
$ErrorActionPreference = 'Stop'

function Get-UpdatedPath([string]$CurrentPath, [string]$Directory) {
    $target = [Environment]::ExpandEnvironmentVariables($Directory).TrimEnd('\')
    $remaining = @($CurrentPath -split ';' | Where-Object {
        $_.Trim() -and
        [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ine $target
    })
    return (@($Directory) + $remaining) -join ';'
}

function Get-NodeMajor([string]$Executable) {
    $version = & $Executable --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') {
        throw "Cannot read the Node.js version from $Executable."
    }
    return [int]$Matches[1]
}

function Install-NodeRuntime([string]$RuntimeDir) {
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    $runtime = Join-Path $RuntimeDir 'node.exe'
    if ((Test-Path -LiteralPath $runtime) -and (Get-NodeMajor $runtime) -ge 20) { return $runtime }
    $existing = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($existing -and (Get-NodeMajor $existing.Source) -ge 20) {
        Copy-Item -LiteralPath $existing.Source -Destination $runtime -Force
        $license = Join-Path (Split-Path $existing.Source) 'LICENSE'
        if (Test-Path -LiteralPath $license) { Copy-Item -LiteralPath $license -Destination $RuntimeDir -Force }
        return $runtime
    }

    Write-Host '==> Downloading a private Node.js LTS runtime (no administrator rights required)...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($architecture) {
        'ARM64' { 'arm64' }
        'AMD64' { 'x64' }
        'x86' { 'x86' }
        default { throw "Unsupported Windows architecture: $architecture" }
    }
    $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $release = $releases |
        Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and [int]($_.version.Split('.')[0].TrimStart('v')) -ge 20 } |
        Select-Object -First 1
    if (-not $release) { throw "No supported Node.js LTS download is available for $arch." }
    $name = "node-$($release.version)-win-$arch"
    $base = "https://nodejs.org/dist/$($release.version)"
    $temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        $zip = Join-Path $temp "$name.zip"
        Invoke-WebRequest "$base/$name.zip" -UseBasicParsing -OutFile $zip
        $checksums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
        $pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape("$name.zip") + '\r?$'
        if ($checksums -notmatch $pattern) { throw 'Node.js download checksum is missing.' }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $Matches[1]) {
            throw 'Node.js download failed SHA-256 verification.'
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $temp
        Copy-Item -LiteralPath (Join-Path $temp "$name\node.exe") -Destination $runtime
        Copy-Item -LiteralPath (Join-Path $temp "$name\LICENSE") -Destination $RuntimeDir
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
    if ((Get-NodeMajor $runtime) -lt 20) { throw 'Node.js 20+ is required.' }
    return $runtime
}

function Write-Launchers([string]$Directory, [string]$App) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $cmd = "@echo off`r`n`"%~dp0..\runtime\node.exe`" `"%~dp0..\bin\$App.js`" %*`r`nexit /b %errorlevel%`r`n"
    [IO.File]::WriteAllText((Join-Path $Directory "$App.cmd"), $cmd, [Text.Encoding]::ASCII)
    $sh = @'
#!/bin/sh
dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
exec "$dir/../runtime/node.exe" "$dir/../bin/__APP__.js" "$@"
'@
    [IO.File]::WriteAllText((Join-Path $Directory $App), $sh.Replace('__APP__', $App).Replace("`r`n", "`n") + "`n", [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $Directory 'activate.cmd'), "@echo off`r`nset `"PATH=%~dp0;%PATH%`"`r`n", [Text.Encoding]::ASCII)
}

function Send-EnvironmentChanged {
    if (-not ('CliSetup.NativeMethods' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CliSetup {
    public static class NativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wParam,
            string lParam, uint flags, uint timeout, out UIntPtr result);
    }
}
'@
    }
    $result = [UIntPtr]::Zero
    $sent = [CliSetup.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    if ($sent -eq [IntPtr]::Zero) {
        Write-Warning 'PATH is saved, but Windows did not acknowledge the environment notification. Sign out and back in if newly launched terminals still have the old PATH.'
    }
}

function Install-App {
    $sourceDir = $PSScriptRoot
    $package = Get-Content -LiteralPath (Join-Path $sourceDir 'package.json') -Raw | ConvertFrom-Json
    $app = $package.name
    if ($app -notmatch '^[a-z0-9-]+$') { throw 'Invalid application name in package.json.' }
    $installDir = Join-Path $env:LOCALAPPDATA $app
    $commandDir = Join-Path $installDir 'command'
    if ([IO.Path]::GetFullPath($sourceDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($installDir).TrimEnd('\')) {
        Write-Host "==> Installing $app to $installDir ..."
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        foreach ($item in 'bin', 'lib', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'setup.cmd', 'setup.ps1', 'setup.sh') {
            $from = Join-Path $sourceDir $item
            $to = Join-Path $installDir $item
            if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
            if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $to -Recurse -Force }
        }
    }
    Get-ChildItem -LiteralPath $installDir -Recurse -File | Unblock-File
    $node = Install-NodeRuntime (Join-Path $installDir 'runtime')
    Write-Host "==> Using private Node.js $(& $node --version)"
    # These applications have no npm dependencies. Run the downloader directly, not npm.ps1.
    & $node (Join-Path $installDir 'scripts\postinstall.js') --strict
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Fix the reported download error and run setup again.' }
    foreach ($tool in @(
        @{ Path = 'vendor\yt-dlp.exe'; Argument = '--version' },
        @{ Path = 'vendor\ffmpeg\ffmpeg.exe'; Argument = '-version' },
        @{ Path = 'vendor\ffmpeg\ffprobe.exe'; Argument = '-version' }
    )) {
        $output = & (Join-Path $installDir $tool.Path) $tool.Argument 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$($tool.Path) cannot run: $output" }
    }
    Write-Launchers $commandDir $app
    $userPath = Get-UpdatedPath ([Environment]::GetEnvironmentVariable('Path', 'User')) $commandDir
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    $env:Path = "$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$userPath"
    Send-EnvironmentChanged

    # Check real command discovery in clean child shells, not an absolute launcher path.
    $location = Get-Location
    try {
        Set-Location -LiteralPath ([IO.Path]::GetTempPath())
        $cmdOutput = & $env:ComSpec /d /c "where $app && $app --version" 2>&1
        if ($LASTEXITCODE -ne 0 -or $cmdOutput[-1].Trim() -ne $package.version) {
            throw "Command Prompt verification failed: $cmdOutput"
        }
        $psOutput = & "$PSHOME\powershell.exe" -NoProfile -Command "`$ErrorActionPreference = 'Stop'; `$c = Get-Command $app; if (`$c.Source -ne '$($commandDir.Replace("'", "''"))\$app.cmd') { throw ('Another command shadows this installation: ' + `$c.Source) }; & $app --version; exit `$LASTEXITCODE" 2>&1
        if ($LASTEXITCODE -ne 0 -or "$psOutput".Trim() -ne $package.version) {
            throw "PowerShell verification failed: $psOutput"
        }
    } finally {
        Set-Location -LiteralPath $location
    }
    Write-Host "`n$app v$($package.version) is installed in $installDir" -ForegroundColor Green
    Write-Host 'Verified command discovery in Command Prompt and PowerShell.'
    Write-Host "The downloaded/extracted source folder is no longer needed."
    Write-Host 'Existing PowerShell, Windows Terminal, VS Code and Git Bash processes may still have their old PATH.'
    Write-Host 'Fully quit and reopen the terminal application, or activate in the current PowerShell session with:'
    Write-Host ('  $env:Path = "' + $commandDir + ';$env:Path"')
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Install-App } catch {
        Write-Host "Setup FAILED: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
