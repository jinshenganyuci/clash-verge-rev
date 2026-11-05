param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath,
    [string] $PreviousInstallerPath,
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
foreach ($script in @($PSCommandPath, (Join-Path $PSScriptRoot 'stop-xboard-processes.ps1'), (Join-Path $PSScriptRoot 'migrate-ikun-install.ps1'))) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
if ($PreviousInstallerPath) { $PreviousInstallerPath = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path }
$marker = 'xboard-smoke-' + [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $env:ProgramFiles 'IKUN'
$legacyRoot = Join-Path $env:ProgramFiles 'Clash Verge Xboard'
$activeInstallRoot = if ($PreviousInstallerPath) { $legacyRoot } else { $installRoot }
$appData = Join-Path $env:APPDATA 'io.github.jinshenganyuci.clash-verge-xboard'
$serviceRoot = Join-Path $env:ProgramData 'clash-verge-service-xboard'
$upstreamData = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$upstreamServiceRoot = Join-Path $env:ProgramData 'clash-verge-service'
$sentinelRoot = Join-Path $env:RUNNER_TEMP $marker
$artifactDirectory = if ($PreviousInstallerPath) { 'ikun-upgrade-smoke-artifacts' } else { 'ikun-smoke-artifacts' }
$artifacts = Join-Path $env:RUNNER_TEMP $artifactDirectory
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
$previousBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
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

function Invoke-BoundedProcess([string] $Path, [string] $Arguments, [int] $TimeoutSeconds = 120, [string] $LogPrefix = '') {
    $options = @{ FilePath = $Path; PassThru = $true }
    if ($Arguments) { $options.ArgumentList = $Arguments }
    if ($LogPrefix) {
        $options.NoNewWindow = $true
        $options.RedirectStandardOutput = Join-Path $artifacts "$LogPrefix.stdout.log"
        $options.RedirectStandardError = Join-Path $artifacts "$LogPrefix.stderr.log"
    }
    try {
        $process = Start-Process @options
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { Save-ProcessTimeoutDiagnostics $process $Path }
            catch { Write-Warning "Timeout diagnostics failed: $_" }
            $process.Refresh()
            if (-not $process.HasExited) { $process.Kill($true) }
            throw "Process timed out after ${TimeoutSeconds}s: $Path"
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Process failed ($($process.ExitCode)): $Path" }
    } finally {
        if ($LogPrefix) {
            foreach ($log in @($options.RedirectStandardOutput, $options.RedirectStandardError)) {
                if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | ForEach-Object { Write-Host $_ } }
            }
        }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class XboardSmokeWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr length, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
    public sealed class WindowInfo {
        public long Handle;
        public uint ProcessId;
        public string ClassName;
        public string Text;
        public bool Visible;
        public Rect Bounds;
        public string[] ChildText;
    }
    private static string ReadText(IntPtr window) {
        var text = new StringBuilder(2048);
        UIntPtr result;
        SendMessageTimeout(window, 0x000D, (UIntPtr)2048, text, 0x0002, 200, out result);
        return text.ToString();
    }
    public static bool HasOwnedForeground(uint[] processIds) {
        uint owner;
        GetWindowThreadProcessId(GetForegroundWindow(), out owner);
        return new HashSet<uint>(processIds).Contains(owner);
    }
    public static WindowInfo[] DescribeWindows(uint[] processIds) {
        var owners = new HashSet<uint>(processIds);
        var windows = new List<WindowInfo>();
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (!owners.Contains(owner)) return true;
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            Rect rectangle;
            GetWindowRect(window, out rectangle);
            var children = new List<string>();
            EnumChildWindows(window, (child, childParameter) => {
                uint childOwner;
                GetWindowThreadProcessId(child, out childOwner);
                if (owners.Contains(childOwner) && children.Count < 100) {
                    string value = ReadText(child);
                    if (!String.IsNullOrWhiteSpace(value)) children.Add(value);
                }
                return true;
            }, IntPtr.Zero);
            windows.Add(new WindowInfo {
                Handle = window.ToInt64(), ProcessId = owner,
                ClassName = name.ToString(), Text = ReadText(window),
                Visible = IsWindowVisible(window), Bounds = rectangle,
                ChildText = children.ToArray()
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static IntPtr FindApplicationWindow(uint processId) {
        IntPtr found = IntPtr.Zero;
        long largestArea = 0;
        EnumWindows((window, parameter) => {
            uint owner;
            Rect rectangle;
            GetWindowThreadProcessId(window, out owner);
            if (owner == processId && IsWindowVisible(window) && GetWindowRect(window, out rectangle)) {
                int width = rectangle.Right - rectangle.Left;
                int height = rectangle.Bottom - rectangle.Top;
                long area = (long)width * height;
                if (width >= 640 && height >= 400 && area > largestArea) {
                    found = window;
                    largestArea = area;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

function Save-ProcessTimeoutDiagnostics([Diagnostics.Process] $Process, [string] $Path) {
    $directory = Join-Path $artifacts "timeout-$($Process.Id)"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $snapshot = @(Get-CimInstance Win32_Process)
    $ownedIds = [Collections.Generic.HashSet[uint32]]::new()
    [void]$ownedIds.Add([uint32]$Process.Id)
    do {
        $added = $false
        foreach ($entry in $snapshot) {
            if ($ownedIds.Contains([uint32]$entry.ParentProcessId) -and $ownedIds.Add([uint32]$entry.ProcessId)) { $added = $true }
        }
    } while ($added)
    [uint32[]] $processIds = @($ownedIds)
    $windows = @([XboardSmokeWindow]::DescribeWindows($processIds))
    $registry = @(foreach ($hive in @('HKLM:', 'HKCU:')) {
        foreach ($key in @("$hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clash Verge Xboard", "$hive\Software\jinshenganyuci\Clash Verge Xboard")) {
            if (Test-Path -LiteralPath $key) {
                $item = Get-Item -LiteralPath $key
                [PSCustomObject]@{
                    Path = $key
                    Default = $item.GetValue('')
                    DisplayName = $item.GetValue('DisplayName')
                    DisplayVersion = $item.GetValue('DisplayVersion')
                    InstallLocation = $item.GetValue('InstallLocation')
                    MainBinaryName = $item.GetValue('MainBinaryName')
                    UninstallString = $item.GetValue('UninstallString')
                }
            }
        }
    })
    $state = [ordered]@{
        Executable = $Path
        Processes = @($snapshot | Where-Object { $ownedIds.Contains([uint32]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
        Windows = $windows
        Registry = $registry
        Service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" | Select-Object Name, DisplayName, State, StartMode, PathName
        Files = @(foreach ($root in @($installRoot, $legacyRoot)) {
            if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -File -Recurse | Select-Object FullName, Length, LastWriteTimeUtc }
        })
    }
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'state.json')
    foreach ($window in $windows) {
        Write-Host "Owned timeout window [$($window.ProcessId)] $($window.Text): $($window.ChildText -join ' | ')"
    }
    Add-Type -AssemblyName System.Drawing, System.Windows.Forms
    foreach ($window in @($windows | Where-Object Visible)) {
        try {
            [void][XboardSmokeWindow]::SetForegroundWindow([IntPtr]$window.Handle)
            Start-Sleep -Milliseconds 250
            if (-not [XboardSmokeWindow]::HasOwnedForeground($processIds)) { continue }
            $rectangle = $window.Bounds
            $windowBounds = [Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
            $bounds = [Drawing.Rectangle]::Intersect($windowBounds, [Windows.Forms.SystemInformation]::VirtualScreen)
            if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { continue }
            $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                $bitmap.Save((Join-Path $directory "window-$($window.Handle).png"), [Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        } catch { Write-Warning "Owned timeout window screenshot failed: $_" }
    }
}

function Set-AppDebugPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $port = $listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
    # This process-only setting is inherited by the CI-launched app, never persisted.
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    return $port
}

function Wait-AppReady([Diagnostics.Process] $Process) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Seconds 1
        $Process.Refresh()
        if ($Process.HasExited) { throw "Installed app exited during startup ($($Process.ExitCode))." }
        $webView = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object ParentProcessId -eq $Process.Id
        $window = [XboardSmokeWindow]::FindApplicationWindow([uint32]$Process.Id)
        if ((Test-Path (Join-Path $appData 'verge.yaml')) -and $window -ne [IntPtr]::Zero -and $webView) {
            $rectangle = [XboardSmokeWindow+Rect]::new()
            [void][XboardSmokeWindow]::GetWindowRect($window, [ref]$rectangle)
            Write-Host "Visible application window: $($rectangle.Right - $rectangle.Left)x$($rectangle.Bottom - $rectangle.Top), PID $($Process.Id)."
            return
        }
    }
    throw 'Installed app did not create its own config, visible 640x400 window and WebView2 process within 60 seconds.'
}

function Assert-AppUI([Diagnostics.Process] $Process, [int] $Port, [string] $Mode, [string] $Brand = 'IKUN') {
    $diagnostics = Get-Content -LiteralPath (Join-Path $artifacts "$Mode-webview-processes.json") -Raw | ConvertFrom-Json
    $debugEnabled = @($diagnostics.DirectWebViewProcesses | Where-Object HasExpectedDebugPort).Count -gt 0
    if ($debugEnabled -and $Brand -eq 'IKUN') {
        $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        $helper = Join-Path $PSScriptRoot 'xboard-ui-smoke.mjs'
        Invoke-BoundedProcess $node "`"$helper`" --port $Port --mode $Mode --artifacts `"$artifacts`" --data-dir `"$appData`"" 180 "$Mode-ui"
        return
    }
    Write-Host 'WebView2 did not enable CDP; checking the installed UI through Windows UI Automation.'
    $window = [XboardSmokeWindow]::FindApplicationWindow([uint32]$Process.Id)
    if ($window -eq [IntPtr]::Zero) { throw 'The visible application window disappeared before UI Automation.' }
    # Windows PowerShell loads the OS .NET Framework UIA assemblies without pwsh's WPF resolution differences.
    $legacyPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $helper = Join-Path $sentinelRoot 'xboard-ui-automation.ps1'
    $uiaScript = @'
param(
    [Parameter(Mandatory = $true)][long] $WindowHandle,
    [Parameter(Mandatory = $true)][ValidateSet('first-run', 'reinstall')][string] $Mode,
    [Parameter(Mandatory = $true)][string] $Artifacts,
    [Parameter(Mandatory = $true)][string] $DataDirectory,
    [Parameter(Mandatory = $true)][string] $Brand
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'UI Automation is limited to disposable Windows GitHub runners.'
}
$lastNames = @()
$evidence = [ordered]@{ mode = $Mode; transport = 'Windows UI Automation'; welcome = $false; main = $false; markerWrittenByApp = $false }
function Write-Evidence([string] $Name, [object] $Value) {
    [IO.File]::WriteAllText((Join-Path $Artifacts $Name), ($Value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Windows.Forms
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class XboardUiaInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint type; public MouseInput mouse; }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    public static void Click(int x, int y) {
        if (!SetCursorPos(x, y)) throw new Win32Exception();
        Input[] inputs = new Input[2];
        inputs[0].mouse.flags = 0x0002;
        inputs[1].mouse.flags = 0x0004;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) throw new Win32Exception();
    }
}
"@
    function Find-NamedControl([object[]] $Items, [string[]] $Names) {
        $normalized = @($Names | ForEach-Object { ($_ -replace '\s', '').ToLowerInvariant() })
        return $Items | Where-Object { $_.Normalized -in $normalized } | Select-Object -First 1
    }
    function Get-UiState {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
        $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $items = @(foreach ($element in $elements) {
            try {
                $current = $element.Current
                if (-not $current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace($current.Name)) {
                    [PSCustomObject]@{
                        Name = $current.Name
                        Normalized = ($current.Name -replace '\s', '').ToLowerInvariant()
                        Element = $element
                    }
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] { }
        })
        $script:lastNames = @($items | ForEach-Object { $_.Name.Substring(0, [Math]::Min(160, $_.Name.Length)) } | Select-Object -Unique -First 80)
        $welcome = Find-NamedControl $items @("欢迎使用 $Brand", "Welcome to $Brand")
        $login = Find-NamedControl $items @('登录', 'Sign in')
        $register = Find-NamedControl $items @('注册账号', 'Register')
        $skip = Find-NamedControl $items @('暂时跳过，进入客户端', 'Skip for now and open the client')
        $homeControl = Find-NamedControl $items @('首页', '首頁', 'Home')
        $account = Find-NamedControl $items @('账户', '帳戶', 'Account')
        [PSCustomObject]@{
            Welcome = [bool]$welcome
            Login = [bool]$login
            Register = [bool]$register
            Skip = if ($skip) { $skip.Element } else { $null }
            Main = -not $welcome -and -not $skip -and [bool]$homeControl -and [bool]$account
        }
    }
    function Save-UiaScreenshot([string] $Name) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
        $rect = $root.Current.BoundingRectangle
        $window = [Drawing.Rectangle]::new([int]$rect.Left, [int]$rect.Top, [int]$rect.Width, [int]$rect.Height)
        $bounds = [Drawing.Rectangle]::Intersect($window, [Windows.Forms.SystemInformation]::VirtualScreen)
        if ($bounds.Width -lt 640 -or $bounds.Height -lt 400) { throw 'UI Automation screenshot is smaller than 640x400.' }
        $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save((Join-Path $Artifacts $Name), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
        return @{ width = $bounds.Width; height = $bounds.Height }
    }
    $markerPath = Join-Path $DataDirectory 'xboard-onboarding-complete'
    if ($Mode -eq 'first-run') {
        if (Test-Path -LiteralPath $markerPath) { throw 'Onboarding was already complete before the UI test.' }
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        do {
            $state = Get-UiState
            $ready = $state.Welcome -and $state.Login -and $state.Register -and $null -ne $state.Skip -and $state.Skip.Current.IsEnabled
            if ($ready) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw 'UI Automation did not expose the welcome heading, login/register tabs and enabled Skip button within 60 seconds.' }
        $evidence.welcome = $true
        $evidence['welcomeNames'] = $lastNames
        $evidence['screenshot'] = Save-UiaScreenshot 'first-run-window.png'
        $pattern = $null
        if ($state.Skip.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
            $evidence['skipAction'] = 'InvokePattern'
        } else {
            $point = $state.Skip.GetClickablePoint()
            [XboardUiaInput]::Click([int]$point.X, [int]$point.Y)
            $evidence['skipAction'] = 'SendInput'
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $state = Get-UiState
        $complete = (Test-Path -LiteralPath $markerPath) -and (Get-Content -LiteralPath $markerPath -Raw) -eq '1'
        $ready = $state.Main -and $complete
        if ($ready) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw 'UI Automation did not find home/account navigation without welcome, together with the app-written onboarding marker.' }
    $evidence.main = $true
    $evidence.markerWrittenByApp = $true
    $evidence['mainNames'] = $lastNames
    $evidence['mainScreenshot'] = Save-UiaScreenshot "$Mode-home.png"
    Write-Evidence "$Mode-ui.json" $evidence
    Write-Host "$Mode UI Automation: real UI, Skip and persisted onboarding passed."
} catch {
    $failure = @{ error = $_.Exception.Message; names = $lastNames; evidence = $evidence }
    Write-Evidence "$Mode-ui-failure.json" $failure
    Write-Host ($failure | ConvertTo-Json -Depth 6)
    throw
}
'@
    Set-Content -LiteralPath $helper -Value $uiaScript -Encoding utf8BOM
    Invoke-BoundedProcess $legacyPowerShell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`" -WindowHandle $($window.ToInt64()) -Mode $Mode -Artifacts `"$artifacts`" -DataDirectory `"$appData`" -Brand `"$Brand`"" 180 "$Mode-ui"
}

function Save-WebViewDiagnostics([Diagnostics.Process] $Process, [int] $Port, [string] $Mode) {
    $children = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object ParentProcessId -eq $Process.Id)
    $records = @($children | ForEach-Object {
        [PSCustomObject]@{
            ProcessId = $_.ProcessId
            ParentProcessId = $_.ParentProcessId
            HasExpectedDebugPort = [bool]($_.CommandLine -match "--remote-debugging-port=$Port(?!\d)")
        }
    })
    @{ RequestedPort = $Port; DirectWebViewProcesses = $records } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifacts "$Mode-webview-processes.json")
}

function Save-NativeWindowScreenshot([Diagnostics.Process] $Process, [string] $Mode) {
    try {
        Add-Type -AssemblyName System.Drawing, System.Windows.Forms
        $window = [XboardSmokeWindow]::FindApplicationWindow([uint32]$Process.Id)
        if ($window -eq [IntPtr]::Zero) { throw 'The visible application window disappeared.' }
        [void][XboardSmokeWindow]::SetForegroundWindow($window)
        Start-Sleep -Seconds 2
        $rectangle = [XboardSmokeWindow+Rect]::new()
        if (-not [XboardSmokeWindow]::GetWindowRect($window, [ref]$rectangle)) { throw 'Cannot read the application window rectangle.' }
        $windowBounds = [Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
        $bounds = [Drawing.Rectangle]::Intersect($windowBounds, [Windows.Forms.SystemInformation]::VirtualScreen)
        if ($bounds.Width -lt 640 -or $bounds.Height -lt 400) { throw 'The visible desktop does not contain a 640x400 application rectangle.' }
        $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save((Join-Path $artifacts "native-$Mode.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    } catch {
        $_.Exception.Message | Set-Content -LiteralPath (Join-Path $artifacts "native-$Mode-error.txt")
        Write-Warning "Native window diagnostic screenshot unavailable: $_"
    }
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

foreach ($path in @($installRoot, $legacyRoot, $appData, $serviceRoot, $upstreamData, $upstreamServiceRoot) + $registryKeys + $files) {
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
        if ($PreviousInstallerPath) {
            Invoke-BoundedProcess $PreviousInstallerPath "/S /D=$legacyRoot" 600
        } else {
            Invoke-BoundedProcess $InstallerPath '/S' 600
        }
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
    $binaryName = if ($PreviousInstallerPath) { 'clash-verge-xboard.exe' } else { 'IKUN.exe' }
    $appBinary = Join-Path $activeInstallRoot $binaryName
    foreach ($file in @($appBinary, (Join-Path $serviceRoot 'cores\verge-mihomo.exe'), (Join-Path $serviceRoot 'cores\verge-mihomo-alpha.exe'))) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Installed payload missing: $file" }
    }
    Assert-UpstreamUntouched

    Invoke-BoundedProcess (Join-Path $activeInstallRoot 'resources\clash-verge-service-install.exe') ''
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or -not $service.PathName.Contains('clash-verge-service-xboard')) {
        throw 'The bundled helper did not install the independent production service.'
    }
    $debugPort = Set-AppDebugPort
    $appProcess = Start-Process -FilePath $appBinary -WorkingDirectory $activeInstallRoot -Environment @{ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort" } -PassThru
    Wait-AppReady $appProcess
    Save-NativeWindowScreenshot $appProcess 'first-run'
    Save-WebViewDiagnostics $appProcess $debugPort 'first-run'
    $firstBrand = if ($PreviousInstallerPath) { 'Clash Verge Xboard' } else { 'IKUN' }
    Assert-AppUI $appProcess $debugPort 'first-run' $firstBrand
    if ($bootstrapExpected) {
        $webViewCoverage.status = 'passed'
        $webViewCoverage.reason = 'Real Runtime removal/absence, NSIS bootstrap installation, and the installed application WebView2 startup were exercised.'
        Write-WebViewCoverage
    }
    Assert-UpstreamUntouched
    $onboardingMarker = Join-Path $appData 'xboard-onboarding-complete'
    $dataSentinel = Join-Path $appData 'xboard-smoke-preserved.txt'
    if ((Get-Content -LiteralPath $onboardingMarker -Raw) -ne '1') { throw 'The real Skip action did not persist onboarding completion.' }
    Set-Content -LiteralPath $dataSentinel -Value $marker -NoNewline
    $preservedFiles = @(@{ Path = $onboardingMarker; Content = '1' }, @{ Path = $dataSentinel; Content = $marker })
    if ($PreviousInstallerPath) {
        $protectedSentinel = Join-Path $appData 'ikun-upgrade-dpapi.bin'
        $plain = [Text.Encoding]::UTF8.GetBytes($marker)
        $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($protectedSentinel, $protected)
        $protectedHash = (Get-FileHash -LiteralPath $protectedSentinel -Algorithm SHA256).Hash
        $legacyRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        New-ItemProperty -LiteralPath $legacyRunKey -Name 'Clash Verge Xboard' -Value "`"$appBinary`"" -Force | Out-Null
        $legacyTask = 'Clash Verge Xboard'
        if (Get-ScheduledTask -TaskName $legacyTask -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'The legacy task fixture already exists.' }
        $action = New-ScheduledTaskAction -Execute $appBinary
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $legacyTask -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal | Out-Null
        $upgradeConfig = Join-Path $appData 'ikun-upgrade-config.yaml'
        Set-Content -LiteralPath $upgradeConfig -Value "profile: $marker" -NoNewline
        $preservedFiles += @{ Path = $upgradeConfig; Content = "profile: $marker" }
        $configHashes = @(foreach ($name in @('verge.yaml', 'profiles.yaml')) {
            $path = Join-Path $appData $name
            if (Test-Path -LiteralPath $path) { @{ Path = $path; Hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } }
        })
    }
    $previousAppProcess = $appProcess
    $activeInstallRoot = $installRoot
    # No /D override: the rebrand must discover the old installation and choose IKUN itself.
    Invoke-BoundedProcess $InstallerPath '/S' 180
    $previousAppProcess.Refresh()
    if (-not $previousAppProcess.HasExited) { throw 'Reinstall did not close the running Xboard application.' }
    foreach ($expected in $preservedFiles) {
        if (-not (Test-Path -LiteralPath $expected.Path) -or (Get-Content -LiteralPath $expected.Path -Raw) -ne $expected.Content) {
            throw "Reinstall changed preserved application data: $($expected.Path)"
        }
    }
    $appBinary = Join-Path $installRoot 'IKUN.exe'
    if (-not (Test-Path -LiteralPath $appBinary)) { throw 'The installer did not use the IKUN directory and executable.' }
    $installedIdentity = Get-ItemProperty -LiteralPath 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clash Verge Xboard'
    if ($installedIdentity.DisplayName -ne 'IKUN' -or $installedIdentity.DisplayVersion -ne '2.5.11' -or $installedIdentity.MainBinaryName -ne 'IKUN.exe' -or $installedIdentity.InstallLocation.Trim('"') -ne $installRoot) {
        throw 'The installed display name, version, executable or path was not updated to IKUN.'
    }
    if ((Get-Service -Name $serviceName).DisplayName -ne 'IKUN Service') { throw 'The service display name was not updated to IKUN.' }
    if ($PreviousInstallerPath) {
        if (Test-Path -LiteralPath (Join-Path $legacyRoot 'clash-verge-xboard.exe')) { throw 'The old application executable was left behind.' }
        foreach ($config in $configHashes) {
            if ((Get-FileHash -LiteralPath $config.Path -Algorithm SHA256).Hash -ne $config.Hash) { throw "The installer changed configuration: $($config.Path)" }
        }
        if ((Get-FileHash -LiteralPath $protectedSentinel -Algorithm SHA256).Hash -ne $protectedHash) { throw 'The upgrade changed the encrypted data sentinel.' }
        $restored = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($protectedSentinel), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ([Text.Encoding]::UTF8.GetString($restored) -ne $marker) { throw 'Protected data could not be decrypted after the upgrade.' }
        $runValues = Get-Item -LiteralPath $legacyRunKey
        if ($null -ne $runValues.GetValue('Clash Verge Xboard') -or $runValues.GetValue('IKUN') -ne "`"$appBinary`"") { throw 'The upgrade did not migrate the owned Run entry.' }
        if (Get-ScheduledTask -TaskName $legacyTask -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'The old scheduled task was left behind.' }
        $upgradedTask = Get-ScheduledTask -TaskName 'IKUN' -TaskPath '\'
        if ($upgradedTask.Actions[0].Execute -ne $appBinary) { throw 'The migrated scheduled task points to the wrong executable.' }
        foreach ($directory in @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))) {
            if (Test-Path -LiteralPath (Join-Path $directory 'Clash Verge Xboard.lnk')) { throw 'An old branded shortcut was left behind.' }
            $shortcutPath = Join-Path $directory 'IKUN.lnk'
            if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'An IKUN shortcut is missing after upgrade.' }
            $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
            if ($shortcut.TargetPath -ne $appBinary) { throw 'An IKUN shortcut points to the old executable.' }
        }
        'The released 2.5.10 preview migrated to the IKUN directory/executable, preserving onboarding, configuration and decryptable DPAPI data, with owned shortcuts and startup entries updated.' |
            Set-Content -LiteralPath (Join-Path $artifacts 'legacy-upgrade-result.txt')
    }
    if ((Get-Service -Name $serviceName).Status -ne 'Running') { throw 'Reinstall did not restart the Xboard service.' }
    Assert-UpstreamUntouched
    $debugPort = Set-AppDebugPort
    $appProcess = Start-Process -FilePath $appBinary -WorkingDirectory $installRoot -Environment @{ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort" } -PassThru
    Wait-AppReady $appProcess
    Save-NativeWindowScreenshot $appProcess 'reinstall'
    Save-WebViewDiagnostics $appProcess $debugPort 'reinstall'
    Assert-AppUI $appProcess $debugPort 'reinstall'
    if ((Get-Content -LiteralPath $onboardingMarker -Raw) -ne '1' -or (Get-Content -LiteralPath $dataSentinel -Raw) -ne $marker) {
        throw 'Restart after reinstall changed the onboarding marker or application data.'
    }
    Assert-UpstreamUntouched
    $maintenance = if ($PreviousInstallerPath) { 'First-preview upgrade' } else { 'Same-version reinstall' }
    "$maintenance preserved onboarding and application data, restarted successfully, and left upstream sentinels untouched." |
        Tee-Object -FilePath (Join-Path $artifacts 'reinstall-result.txt')
    Invoke-BoundedProcess (Join-Path $installRoot 'uninstall.exe') "/S _?=$installRoot"
    $installed = $false
    if (Test-Path -LiteralPath $appBinary) { throw 'Uninstaller left the application executable behind.' }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'Uninstaller left the Xboard service registered.' }
    if (Get-ScheduledTask -TaskName 'IKUN' -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Uninstaller left the owned scheduled task behind.' }
    Assert-UpstreamUntouched
    "Syntax, install, core staging, service isolation, application startup, $maintenance and uninstall smoke passed." |
        Tee-Object -FilePath (Join-Path $artifacts 'result.txt')
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousBrowserArguments
    $logDirectory = Join-Path $appData 'logs'
    if (Test-Path $logDirectory) {
        Copy-Item -LiteralPath $logDirectory -Destination (Join-Path $artifacts 'app-logs') -Recurse -Force -ErrorAction Continue
    }
    if ($appProcess -and -not $appProcess.HasExited) { $appProcess.Kill($true); [void]$appProcess.WaitForExit(10000) }
    if ($installed -and (Test-Path (Join-Path $activeInstallRoot 'uninstall.exe'))) {
        try { Invoke-BoundedProcess (Join-Path $activeInstallRoot 'uninstall.exe') "/S _?=$activeInstallRoot" }
        catch { Write-Warning "Cleanup uninstall failed: $_" }
    }
    foreach ($process in $sentinelProcesses) {
        if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(10000) }
    }
    if ($createdUpstreamService) { & sc.exe delete $upstreamServiceName | Out-Null }
    foreach ($entry in $createdRunValues) { Remove-ItemProperty -LiteralPath $entry.Path -Name $entry.Name -ErrorAction SilentlyContinue }
    foreach ($key in $createdKeys) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }
    foreach ($file in $createdFiles) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    foreach ($taskName in @('Clash Verge Xboard', 'IKUN')) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
    }
    foreach ($name in @('Clash Verge Xboard', 'IKUN')) {
        Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -ErrorAction SilentlyContinue
    }
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        Remove-Item -LiteralPath "$hive\Software\jinshenganyuci\Clash Verge Xboard" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clash Verge Xboard" -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($path in @($installRoot, $legacyRoot, $appData, $serviceRoot, $upstreamData, $upstreamServiceRoot, $sentinelRoot)) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}
