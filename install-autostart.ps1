# EasyBrowse 开机自启注册脚本（PowerShell）
# 用法：右键「使用 PowerShell 运行」，或在终端执行 .\install-autostart.ps1
#
# 效果：登录 Windows 后由计划任务 easybrowse-app 无窗口启动 start-hidden.vbs。
#      start-hidden.vbs 是守护式启动器：node 异常退出后按 5s→60s 退避自动拉起，
#      连续 20 次失败才放弃（日志在 data\guardian.log）。
#      因此任务本身的 RestartCount 基本用不上 —— 真正的保活在 vbs 里。
#
# 停止/重启请用 scripts\stop-service.ps1，直接杀 node 会被守护拉回来。

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$vbs  = Join-Path $root 'start-hidden.vbs'
$task = 'easybrowse-app'

if (-not (Test-Path $vbs)) {
    Write-Host "[错误] 未找到 $vbs" -ForegroundColor Red
    exit 1
}

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $task `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description 'EasyBrowse 远程浏览器平台 (127.0.0.1:28471 -> zjc.rainplay.cn:25578)，frpc 由服务托管' -Force | Out-Null

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*src\server.js*' })

if ($running.Count) {
    Write-Host "[完成] 计划任务 $task 已注册" -ForegroundColor Green
    Write-Host "[提示] 平台服务正在运行 (PID $($running.ProcessId -join ','))，未重启以免中断在线用户。"
    Write-Host '       要立刻切到守护模式：.\scripts\stop-service.ps1 -Restart'
} else {
    Start-ScheduledTask -TaskName $task
    Write-Host "[完成] 计划任务 $task 已注册并启动" -ForegroundColor Green
}

Write-Host '查看状态：.\scripts\stop-service.ps1 -Status'
Write-Host '停止服务：.\scripts\stop-service.ps1'
