$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'installer\Package-Tools.ps1')
$target=Get-JavmRoot $PSScriptRoot
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JAVM'
$registered=(Get-ItemProperty -LiteralPath $key).InstallLocation
$programs=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
if ($registered -ne $target -or !$target.StartsWith($programs+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Installation path does not match the current-user registration' }
foreach ($process in Get-Process -Name 'javm-win_x64','javm_database','JAVM' -ErrorAction SilentlyContinue) {
    try { if ($process.Path -and $process.Path.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Close JAVM and its background tasks before uninstalling' } } catch { throw }
}
# Delete only manifest-owned files; keep all user-created files and all databases.
$manifest=Read-JavmManifest $target
foreach ($entry in $manifest.files) {
    $file=Get-JavmChild $target $entry.path
    [void](Get-JavmRoot $file)
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
Remove-Item -LiteralPath (Join-Path $target 'package-manifest.json') -Force
foreach ($link in @((Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\JAVM.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'JAVM.lnk'))) {
    if (Test-Path -LiteralPath $link) { $shell=New-Object -ComObject WScript.Shell;if ($shell.CreateShortcut($link).TargetPath -eq (Join-Path $target 'JAVM.exe')) { Remove-Item -LiteralPath $link -Force } }
}
$protocol='HKCU:\Software\Classes\javm'
$commandKey=Get-Item -LiteralPath ($protocol+'\shell\open\command') -ErrorAction SilentlyContinue
if ($commandKey -and $commandKey.GetValue('') -eq ('"'+(Join-Path $target 'JAVM.exe')+'" "%1"')) { Remove-Item -LiteralPath $protocol -Recurse -Force }
Remove-Item -LiteralPath $key -Recurse -Force
Write-Output 'JAVM removed. User databases, media, backups and unlisted files were preserved.'
