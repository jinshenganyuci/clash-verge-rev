$ErrorActionPreference = 'Stop'
try {
    $root = [IO.Path]::GetFullPath($env:XBOARD_INSTALL_DIRECTORY).TrimEnd('\') + '\'
    if (Test-Path ($root + 'clash-verge.exe')) { throw 'Choose a separate folder from Clash Verge.' }
    if (Test-Path ($root + 'Clash Verge.exe')) { throw 'Choose a separate folder from Clash Verge.' }
    $serviceRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'clash-verge-service-xboard')).TrimEnd('\') + '\'
    function Stop-OwnedProcesses($names) {
        Get-CimInstance Win32_Process | Where-Object {
            $_.Name -in $names -and $_.ExecutablePath -and (
                $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
                $_.ExecutablePath.StartsWith($serviceRoot, [StringComparison]::OrdinalIgnoreCase)
            )
        } | ForEach-Object {
            $owned = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($owned) {
                $owned.Kill()
                if (-not $owned.WaitForExit(30000)) { throw 'A process did not stop.' }
            }
        }
    }
    Stop-OwnedProcesses @('IKUN.exe', 'clash-verge-xboard.exe')
    $service = Get-Service -Name 'clash_verge_service_xboard' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -InputObject $service -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    Stop-OwnedProcesses @('clash-verge-service.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe')
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
