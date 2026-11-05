param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath,
    [switch] $ExerciseMissingWebView2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This smoke test only runs on disposable GitHub-hosted Windows runners.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The packaging smoke test requires an elevated runner.'
}
foreach ($script in @($PSCommandPath, (Join-Path $PSScriptRoot 'stop-xboard-processes.ps1'))) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$marker = 'xboard-smoke-' + [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $env:ProgramFiles 'Clash Verge Xboard CI'
$appData = Join-Path $env:APPDATA 'io.github.jinshenganyuci.clash-verge-xboard'
$serviceRoot = Join-Path $env:ProgramData 'clash-verge-service-xboard'
$upstreamData = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$upstreamServiceRoot = Join-Path $env:ProgramData 'clash-verge-service'
$sentinelRoot = Join-Path $env:RUNNER_TEMP $marker
$artifacts = Join-Path $env:RUNNER_TEMP 'xboard-smoke-artifacts'
$serviceName = 'clash_verge_service_xboard'
$upstreamServiceName = 'clash_verge_service'
$upstreamServiceBinary = "$env:SystemRoot\System32\cmd.exe /c exit 0"
$registryKeys = @(
    'HKCU:\Software\Classes\clash',
    'HKCU:\Software\Classes\clash-verge',
    'HKLM:\Software\Classes\clash',
    'HKLM:\Software\Classes\clash-verge',
    'HKCU:\Software\Clash Verge',
    'HKCU:\Software\Clash Verge Rev',
    'HKLM:\Software\Clash Verge',
    'HKLM:\Software\Clash Verge Rev',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clash Verge',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clash Verge'
)
$runKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$files = @(
    (Join-Path $upstreamData 'window-state.json'),
    (Join-Path $upstreamData '.window-state.json'),
    (Join-Path $upstreamServiceRoot 'xboard-smoke-sentinel.txt'),
    (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Clash Verge.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Startup')) 'Clash Verge.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Clash Verge\xboard-smoke-sentinel.txt')
)
$createdKeys = @()
$createdRunValues = @()
$createdFiles = @()
$sentinelProcesses = @()
$appProcess = $null
$createdUpstreamService = $false
$installed = $false
$webViewKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$webViewCoverage = [ordered]@{
    requested = [bool]$ExerciseMissingWebView2
    status = 'not-exercised'
    reason = 'The missing-runtime scenario was not requested.'
    before = @()
    afterUninstall = @()
    afterInstall = @()
}

function Get-WebViewClients {
    foreach ($key in $webViewKeys) {
        if (Test-Path -LiteralPath $key) {
            $version = (Get-Item -LiteralPath $key).GetValue('pv')
            if (-not [string]::IsNullOrEmpty($version)) {
                [PSCustomObject]@{ Key = $key; Version = [string]$version }
            }
        }
    }
}

function Write-WebViewCoverage {
    $webViewCoverage | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $artifacts 'webview2-bootstrap.json')
    $message = "WebView2 missing-runtime check: $($webViewCoverage.status). $($webViewCoverage.reason)"
    Write-Host $message
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $message }
}

function Invoke-BoundedProcess([string] $Path, [string] $Arguments, [int] $TimeoutSeconds = 120) {
    $options = @{ FilePath = $Path; PassThru = $true }
    if ($Arguments) { $options.ArgumentList = $Arguments }
    $process = Start-Process @options
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        throw "Process timed out after ${TimeoutSeconds}s: $Path"
    }
    if ($process.ExitCode -ne 0) { throw "Process failed ($($process.ExitCode)): $Path" }
}

function Assert-UpstreamUntouched {
    foreach ($key in $createdKeys) {
        if (-not (Test-Path -LiteralPath $key) -or (Get-Item -LiteralPath $key).GetValue('') -ne $marker) {
            throw "Upstream registry sentinel changed: $key"
        }
    }
    foreach ($entry in $createdRunValues) {
        if ((Get-ItemPropertyValue -LiteralPath $entry.Path -Name $entry.Name) -ne $marker) {
            throw "Upstream autostart sentinel changed: $($entry.Name)"
        }
    }
    foreach ($file in $createdFiles) {
        if (-not (Test-Path -LiteralPath $file) -or (Get-Content -LiteralPath $file -Raw).TrimEnd() -ne $marker) {
            throw "Upstream file sentinel changed: $file"
        }
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='$upstreamServiceName'"
    if (-not $service -or $service.State -ne 'Stopped' -or $service.PathName -ne $upstreamServiceBinary) {
        throw 'Upstream service sentinel changed.'
    }
    foreach ($process in $sentinelProcesses) {
        $process.Refresh()
        if ($process.HasExited) { throw "Upstream process sentinel was stopped: $($process.Id)" }
    }
}

foreach ($path in @($installRoot, $appData, $serviceRoot, $upstreamData, $upstreamServiceRoot) + $registryKeys + $files) {
    if (Test-Path -LiteralPath $path) { throw "Expected a clean disposable runner, but found: $path" }
}
foreach ($name in @($serviceName, $upstreamServiceName)) {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw "Service already exists: $name" }
}
foreach ($key in $runKeys) {
    foreach ($name in @('Clash Verge', 'clash-verge')) {
        if ((Test-Path -LiteralPath $key) -and $null -ne (Get-Item -LiteralPath $key).GetValue($name)) {
            throw "Autostart entry already exists: $key / $name"
        }
    }
}
New-Item -ItemType Directory -Path $artifacts, $sentinelRoot -Force | Out-Null
try {
    foreach ($key in $registryKeys) {
        New-Item -Path $key -Force | Out-Null
        $createdKeys += $key
        Set-Item -LiteralPath $key -Value $marker
        if ($key.Contains('\Uninstall\')) {
            New-ItemProperty -LiteralPath $key -Name DisplayName -Value 'Clash Verge' | Out-Null
        }
    }
    foreach ($key in $runKeys) {
        New-Item -Path $key -Force | Out-Null
        foreach ($name in @('Clash Verge', 'clash-verge')) {
            New-ItemProperty -LiteralPath $key -Name $name -Value $marker | Out-Null
            $createdRunValues += @{ Path = $key; Name = $name }
        }
    }
    foreach ($file in $files) {
        New-Item -ItemType Directory -Path (Split-Path $file) -Force | Out-Null
        Set-Content -LiteralPath $file -Value $marker
        $createdFiles += $file
    }
    New-Service -Name $upstreamServiceName -BinaryPathName $upstreamServiceBinary -StartupType Manual | Out-Null
    $createdUpstreamService = $true
    foreach ($name in @('verge-mihomo.exe', 'clash-verge-service.exe')) {
        $binary = Join-Path $sentinelRoot $name
        Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $binary
        $sentinelProcesses += Start-Process -FilePath $binary -ArgumentList '/d /c "ping.exe -n 3600 127.0.0.1 >nul"' -WindowStyle Hidden -PassThru
    }

    $webViewCoverage.before = @(Get-WebViewClients)
    if ($ExerciseMissingWebView2 -and $webViewCoverage.before.Count -gt 0) {
        $uninstallNotes = @()
        $attempted = $false
        $runtimeRoots = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'),
            (Join-Path $env:ProgramFiles 'Microsoft\EdgeWebView\Application')
        ) | Select-Object -Unique
        foreach ($root in $runtimeRoots) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            $candidates = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
                $parsed = $null
                [Version]::TryParse($_.Name, [ref]$parsed)
            } | Sort-Object { [Version]$_.Name } -Descending)
            foreach ($directory in $candidates) {
                $setup = Join-Path $directory.FullName 'Installer\setup.exe'
                if (-not (Test-Path -LiteralPath $setup)) { continue }
                $attempted = $true
                try {
                    # Microsoft Intune documents this version-specific Runtime uninstall command:
                    # https://techcommunity.microsoft.com/blog/intunecustomersuccess/support-tip-bulk-installing-webview2-runtime-on-windows-10-devices/3678202
                    Invoke-BoundedProcess $setup '--force-uninstall --uninstall --msedgewebview --system-level --verbose-logging' 120
                } catch {
                    $uninstallNotes += $_.Exception.Message
                }
                break
            }
        }
        for ($attempt = 0; $attempt -lt 20 -and @(Get-WebViewClients).Count -gt 0; $attempt++) {
            Start-Sleep -Milliseconds 500
        }
        $webViewCoverage.afterUninstall = @(Get-WebViewClients)
        if ($webViewCoverage.afterUninstall.Count -gt 0) {
            $webViewCoverage.reason = if (-not $attempted) {
                'No system Runtime setup.exe was available; preinstalled WebView2 remains. No registry values or runtime files were removed manually.'
            } else {
                'The official uninstall command did not remove all HKLM/HKCU client pv values (the runtime may be protected, in use, or per-user). ' + ($uninstallNotes -join ' ')
            }
            Write-Warning $webViewCoverage.reason
        }
    } else {
        $webViewCoverage.afterUninstall = @(Get-WebViewClients)
    }
    $bootstrapExpected = $webViewCoverage.afterUninstall.Count -eq 0
    if ($bootstrapExpected) {
        $webViewCoverage.status = 'pending'
        $webViewCoverage.reason = 'Both HKLM/HKCU client pv values are absent or empty; NSIS must install WebView2.'
    }
    Write-WebViewCoverage
    # /D and _?= are NSIS remainder arguments and must be last, without surrounding quotes.
    try {
        Invoke-BoundedProcess $InstallerPath "/S /D=$installRoot" 600
    } catch {
        if ($bootstrapExpected) {
            $webViewCoverage.status = 'failed'
            $webViewCoverage.reason = 'NSIS failed while exercising the missing-runtime path: ' + $_.Exception.Message
            $webViewCoverage.afterInstall = @(Get-WebViewClients)
            Write-WebViewCoverage
        }
        throw
    }
    $installed = $true
    $webViewCoverage.afterInstall = @(Get-WebViewClients)
    $validRuntime = @($webViewCoverage.afterInstall | Where-Object {
        $parsed = $null
        [Version]::TryParse($_.Version, [ref]$parsed) -and $parsed -gt [Version]'0.0.0.0'
    })
    if ($bootstrapExpected -and $validRuntime.Count -eq 0) {
        $webViewCoverage.status = 'failed'
        $webViewCoverage.reason = 'NSIS returned without installing a valid WebView2 Runtime.'
        Write-WebViewCoverage
        throw $webViewCoverage.reason
    }
    if ($bootstrapExpected) {
        $webViewCoverage.status = 'runtime-restored'
        $webViewCoverage.reason = 'NSIS restored a valid Runtime after the missing-runtime check; application startup is next.'
    }
    Write-WebViewCoverage
    $appBinary = Join-Path $installRoot 'clash-verge-xboard.exe'
    foreach ($file in @($appBinary, (Join-Path $serviceRoot 'cores\verge-mihomo.exe'), (Join-Path $serviceRoot 'cores\verge-mihomo-alpha.exe'))) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Installed payload missing: $file" }
    }
    Assert-UpstreamUntouched

    Invoke-BoundedProcess (Join-Path $installRoot 'resources\clash-verge-service-install.exe') ''
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or -not $service.PathName.Contains('clash-verge-service-xboard')) {
        throw 'The bundled helper did not install the independent production service.'
    }
    $appProcess = Start-Process -FilePath $appBinary -WorkingDirectory $installRoot -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Seconds 1
        $appProcess.Refresh()
        if ($appProcess.HasExited) { throw "Installed app exited during startup ($($appProcess.ExitCode))." }
        $webView = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object ParentProcessId -eq $appProcess.Id
        if ((Test-Path (Join-Path $appData 'verge.yaml')) -and $appProcess.MainWindowHandle -ne [IntPtr]::Zero -and $webView) {
            $ready = $true
            break
        }
    }
    if (-not $ready) { throw 'Installed app did not create its own config, window and WebView2 process within 60 seconds.' }
    if ($bootstrapExpected) {
        $webViewCoverage.status = 'passed'
        $webViewCoverage.reason = 'Real Runtime removal/absence, NSIS bootstrap installation, and the installed application WebView2 startup were exercised.'
        Write-WebViewCoverage
    }
    try {
        Add-Type -AssemblyName System.Drawing, System.Windows.Forms
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XboardSmokeWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
}
'@
        [void][XboardSmokeWindow]::SetForegroundWindow($appProcess.MainWindowHandle)
        Start-Sleep -Seconds 3
        $rectangle = [XboardSmokeWindow+Rect]::new()
        if ([XboardSmokeWindow]::GetWindowRect($appProcess.MainWindowHandle, [ref]$rectangle)) {
            $windowBounds = [Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
            $bounds = [Drawing.Rectangle]::Intersect($windowBounds, [Windows.Forms.SystemInformation]::VirtualScreen)
            if ($bounds.Width -gt 0 -and $bounds.Height -gt 0) {
                $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
                $graphics = [Drawing.Graphics]::FromImage($bitmap)
                try {
                    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                    $bitmap.Save((Join-Path $artifacts 'first-run-window.png'), [Drawing.Imaging.ImageFormat]::Png)
                } finally {
                    $graphics.Dispose()
                    $bitmap.Dispose()
                }
            }
        }
    } catch {
        Write-Warning "Optional first-run screenshot unavailable on this runner desktop: $_"
    }
    Assert-UpstreamUntouched
    Invoke-BoundedProcess (Join-Path $installRoot 'uninstall.exe') "/S _?=$installRoot"
    $installed = $false
    if (Test-Path -LiteralPath $appBinary) { throw 'Uninstaller left the application executable behind.' }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'Uninstaller left the Xboard service registered.' }
    Assert-UpstreamUntouched
    'Syntax, install, core staging, service isolation, application startup and uninstall smoke passed.' |
        Tee-Object -FilePath (Join-Path $artifacts 'result.txt')
} finally {
    $logDirectory = Join-Path $appData 'logs'
    if (Test-Path $logDirectory) {
        Copy-Item -LiteralPath $logDirectory -Destination (Join-Path $artifacts 'app-logs') -Recurse -Force -ErrorAction Continue
    }
    if ($appProcess -and -not $appProcess.HasExited) { $appProcess.Kill($true); [void]$appProcess.WaitForExit(10000) }
    if ($installed -and (Test-Path (Join-Path $installRoot 'uninstall.exe'))) {
        try { Invoke-BoundedProcess (Join-Path $installRoot 'uninstall.exe') "/S _?=$installRoot" }
        catch { Write-Warning "Cleanup uninstall failed: $_" }
    }
    foreach ($process in $sentinelProcesses) {
        if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(10000) }
    }
    if ($createdUpstreamService) { & sc.exe delete $upstreamServiceName | Out-Null }
    foreach ($entry in $createdRunValues) { Remove-ItemProperty -LiteralPath $entry.Path -Name $entry.Name -ErrorAction SilentlyContinue }
    foreach ($key in $createdKeys) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }
    foreach ($file in $createdFiles) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    foreach ($path in @($installRoot, $appData, $upstreamData, $upstreamServiceRoot, $sentinelRoot)) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}
