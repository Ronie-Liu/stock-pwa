# 创建盘后精选池导出自动化任务
# 每日 15:35 (北京时间) 执行

$taskName = "Stock-Selection-Export"
$scriptDir = "c:\Users\28670\.trae-cn\work\6a1bafa1d33f96294df4bab3\stock-pwa-test2"
$batPath = Join-Path $scriptDir "scripts\run_export.bat"

# 先卸载旧任务(如果存在)
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

# 创建 bat 包装脚本
@"
@echo off
cd /d "$scriptDir"
py scripts\export_selection.py >> "%USERPROFILE%\Desktop\selection_export.log" 2>&1
echo [%date% %time%] Done >> "%USERPROFILE%\Desktop\selection_export.log"
"@ | Out-File -FilePath $batPath -Encoding ASCII

# 创建计划任务
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At "15:35"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "盘后跑SKILL全量板块诊断，导出精选池JSON推GitHub"

Write-Host "✅ 任务已创建: $taskName (每日 15:35)"
