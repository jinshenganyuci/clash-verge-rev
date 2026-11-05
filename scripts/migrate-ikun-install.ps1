param([switch] $Uninstall)

$ErrorActionPreference = 'Stop'
try {
    $destination = [IO.Path]::GetFullPath($env:IKUN_INSTALL_DIRECTORY).TrimEnd('\')
    $newBinary = Join-Path $destination 'IKUN.exe'
    if (-not (Test-Path -LiteralPath $newBinary)) { throw 'The IKUN executable is missing.' }
    $source = if ($Uninstall) { $destination } else { [IO.Path]::GetFullPath($env:IKUN_PREVIOUS_INSTALL_DIRECTORY).TrimEnd('\') }
    $oldBinary = if ($Uninstall) { $newBinary } else { Join-Path $source 'clash-verge-xboard.exe' }
    $oldNames = if ($Uninstall) { @('IKUN', 'Clash Verge Xboard', 'Clash-Verge-Xboard') } else { @('Clash Verge Xboard', 'Clash-Verge-Xboard') }
    $shell = New-Object -ComObject WScript.Shell
    $shortcutRoots = @(
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('DesktopDirectory'),
        [Environment]::GetFolderPath('CommonPrograms'),
        [Environment]::GetFolderPath('Programs'),
        [Environment]::GetFolderPath('Startup'),
        [Environment]::GetFolderPath('CommonStartup')
    ) | Select-Object -Unique
    foreach ($root in $shortcutRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($name in $oldNames) {
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter "$name.lnk" -File -Recurse -ErrorAction SilentlyContinue)) {
                $shortcut = $shell.CreateShortcut($file.FullName)
                if (-not $shortcut.TargetPath.Equals($oldBinary, [StringComparison]::OrdinalIgnoreCase)) { continue }
                if (-not $Uninstall) {
                    $linkDirectory = $file.DirectoryName
                    if ($oldNames -contains $file.Directory.Name) {
                        $linkDirectory = Join-Path $file.Directory.Parent.FullName 'IKUN'
                        New-Item -ItemType Directory -Path $linkDirectory -Force | Out-Null
                    }
                    $linkPath = Join-Path $linkDirectory 'IKUN.lnk'
                    $replacement = $shell.CreateShortcut($linkPath)
                    if ((Test-Path -LiteralPath $linkPath) -and -not $replacement.TargetPath.Equals($newBinary, [StringComparison]::OrdinalIgnoreCase)) {
                        throw "A different application owns shortcut $linkPath."
                    }
                    $replacement.TargetPath = $newBinary
                    $replacement.WorkingDirectory = $destination
                    $replacement.IconLocation = "$newBinary,0"
                    $replacement.Description = 'IKUN'
                    $replacement.Arguments = $shortcut.Arguments
                    $replacement.WindowStyle = $shortcut.WindowStyle
                    $replacement.Hotkey = $shortcut.Hotkey
                    $replacement.Save()
                }
                Remove-Item -LiteralPath $file.FullName -Force
                if (($oldNames -contains $file.Directory.Name) -and @(Get-ChildItem -LiteralPath $file.DirectoryName -Force).Count -eq 0) {
                    Remove-Item -LiteralPath $file.DirectoryName
                }
            }
        }
    }

    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
        $runKey = $registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
        try {
            if ($null -eq $runKey) { continue }
            foreach ($name in $oldNames) {
                $command = $runKey.GetValue($name)
                if ($command -isnot [string]) { continue }
                $prefix = '^(?:"' + [regex]::Escape($oldBinary) + '"|' + [regex]::Escape($oldBinary) + ')(?=\s|$)'
                $match = [regex]::Match($command, $prefix, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
                if (-not $match.Success) { continue }
                if (-not $Uninstall) {
                    $newCommand = '"' + $newBinary + '"' + $command.Substring($match.Length)
                    $existing = $runKey.GetValue('IKUN')
                    if ($existing -and $existing -ne $newCommand) { throw 'A different IKUN autostart entry already exists.' }
                    $runKey.SetValue('IKUN', $newCommand)
                }
                $runKey.DeleteValue($name, $false)
            }
        } finally {
            if ($runKey) { $runKey.Dispose() }
            $registry.Dispose()
        }
    }

    foreach ($suffix in @('', ' (Admin)')) {
        $oldTaskName = if ($Uninstall) { "IKUN$suffix" } else { "Clash Verge Xboard$suffix" }
        $task = Get-ScheduledTask -TaskName $oldTaskName -TaskPath '\' -ErrorAction SilentlyContinue
        if (-not $task) { continue }
        $actions = @($task.Actions)
        if ($actions.Count -ne 1 -or -not $actions[0].Execute.Trim('"').Equals($oldBinary, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not $Uninstall) {
            $newTaskName = "IKUN$suffix"
            $existing = Get-ScheduledTask -TaskName $newTaskName -TaskPath '\' -ErrorAction SilentlyContinue
            if ($existing -and (@($existing.Actions).Count -ne 1 -or -not $existing.Actions[0].Execute.Trim('"').Equals($newBinary, [StringComparison]::OrdinalIgnoreCase))) {
                throw "A different application owns scheduled task $newTaskName."
            }
            [xml] $definition = Export-ScheduledTask -TaskName $oldTaskName -TaskPath '\'
            $definition.Task.Actions.Exec.Command = $newBinary
            if ($definition.Task.Actions.Exec.WorkingDirectory) { $definition.Task.Actions.Exec.WorkingDirectory = $destination }
            if ($definition.Task.RegistrationInfo.URI) { $definition.Task.RegistrationInfo.URI = "\$newTaskName" }
            Register-ScheduledTask -TaskName $newTaskName -TaskPath '\' -Xml $definition.OuterXml -Force | Out-Null
        }
        Unregister-ScheduledTask -TaskName $oldTaskName -TaskPath '\' -Confirm:$false
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
