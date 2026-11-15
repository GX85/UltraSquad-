# Убирает автозапуск UltraSquad.
Unregister-ScheduledTask -TaskName 'UltraSquad' -Confirm:$false -ErrorAction SilentlyContinue
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'UltraSquad.lnk'
if (Test-Path $lnk) { Remove-Item $lnk }
Write-Output 'Автозапуск UltraSquad отключён.'
