# Автозапуск UltraSquad при входе в Windows (без прав администратора).
# Запуск:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$node = (Get-Command node -ErrorAction Stop).Source

# Скрытый запуск без окна консоли
$vbs = Join-Path $root 'scripts\start-hidden.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run """$node"" server.js", 0, False
"@ | Set-Content -Path $vbs -Encoding Unicode

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
try {
  Register-ScheduledTask -TaskName 'UltraSquad' -Action $action -Trigger $trigger -Settings $settings -Description 'UltraSquad agent server (http://127.0.0.1:7777)' -Force | Out-Null
  Write-Output "OK: задача планировщика 'UltraSquad' создана (запуск при входе в Windows)."
} catch {
  # Запасной вариант: ярлык в папке автозагрузки
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'UltraSquad.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = 'wscript.exe'; $s.Arguments = "`"$vbs`""; $s.WorkingDirectory = $root; $s.Save()
  Write-Output "OK: планировщик недоступен ($($_.Exception.Message)); создан ярлык в автозагрузке: $lnk"
}
