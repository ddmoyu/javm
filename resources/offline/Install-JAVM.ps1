param([string]$Destination=(Join-Path $env:LOCALAPPDATA 'Programs\JAVM'),[switch]$DesktopShortcut)
. (Join-Path $PSScriptRoot 'installer\Package-Tools.ps1')
$source=Get-JavmRoot $PSScriptRoot
$target=Get-JavmRoot $Destination
$programs=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
if (!$target.StartsWith($programs+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Install into the current user LocalAppData\Programs directory' }
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Choose an empty directory for this installation.' }
$manifest=Test-JavmPackage $source
[void][IO.Directory]::CreateDirectory($target)
foreach ($entry in $manifest.files) {
    $destinationFile=Get-JavmChild $target $entry.path
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destinationFile))
    [IO.File]::Copy((Get-JavmChild $source $entry.path),$destinationFile,$false)
}
[IO.File]::Copy((Join-Path $source 'package-manifest.json'),(Join-Path $target 'package-manifest.json'),$false)
[void](Test-JavmPackage $target)
$shell=New-Object -ComObject WScript.Shell
$shortcutPath=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\JAVM.lnk'
foreach ($shortcutFile in @($shortcutPath)) {
    $shortcut=$shell.CreateShortcut($shortcutFile);$shortcut.TargetPath=Join-Path $target 'JAVM.exe';$shortcut.WorkingDirectory=$target;$shortcut.Save()
}
if ($DesktopShortcut) { $shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'JAVM.lnk'));$shortcut.TargetPath=Join-Path $target 'JAVM.exe';$shortcut.WorkingDirectory=$target;$shortcut.Save() }
$protocol='HKCU:\Software\Classes\javm'
New-Item -Path ($protocol+'\shell\open\command') -Force | Out-Null
Set-Item -Path $protocol -Value 'URL:JAVM Protocol'
New-ItemProperty -Path $protocol -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path ($protocol+'\shell\open\command') -Value ('"'+(Join-Path $target 'JAVM.exe')+'" "%1"')
$uninstall='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JAVM'
New-Item -Path $uninstall -Force | Out-Null
$values=@{DisplayName='JAVM';DisplayVersion=$manifest.version;Publisher='DDMUOYU';InstallLocation=$target;DisplayIcon=(Join-Path $target 'JAVM.exe');UninstallString=('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $target 'Uninstall-JAVM.ps1')+'"')}
foreach ($key in $values.Keys) { New-ItemProperty -Path $uninstall -Name $key -Value $values[$key] -PropertyType String -Force | Out-Null }
Write-Output "Installed JAVM $($manifest.version) to $target. User media and databases remain in their original locations."
