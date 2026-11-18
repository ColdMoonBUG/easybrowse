# EasyBrowse 开机自启注册脚本（PowerShell）
#
# 用法：
#   .\install-autostart.ps1                 # 开机自启，默认「只开放 /nowapi」的极简模式
#   .\install-autostart.ps1 -Mode full      # 开机自启完整平台（登录页 / 工作区 / 后台）
#   .\install-autostart.ps1 -Off            # 关闭开机自启（服务保持当前运行状态，不动它）
#   .\install-autostart.ps1 -Mode nowapi    # 从 full 切回极简
#
# 原理：登录 Windows 后由计划任务 easybrowse-app 无窗口启动 start-hidden.vbs。
#      start-hidden.vbs 是守护式启动器：node 异常退出后按 5s→60s 退避自动拉起，
#      连续 20 次失败才放弃（日志在 data\guardian.log）。
#
# 模式怎么传到服务：写入 data\autostart-mode.txt（nowapi / full），
# 由 src\config.js 的 resolveNowapiOnly() 读取。.bat 启动器则用环境变量覆盖它。
#
# 停止/重启请用 scripts\stop-service.ps1，直接杀 node 会被守护拉回来。

param(
    [ValidateSet('nowapi', 'full')]
    [string]$Mode = 'nowapi',
    [switch]$Off
)

$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$vbs      = Join-Path $root 'start-hidden.vbs'
$task     = 'easybrowse-app'
$modeFile = Join-Path $root 'data\autostart-mode.txt'

# ---------- 关闭自启 ----------
if ($Off) {
    $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if (-not $t) {
        Write-Host "[信息] 计划任务 $task 不存在，本来就没有开机自启。" -ForegroundColor Yellow
    } else {
        Disable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null
        Write-Host "[完成] 已关闭开机自启（任务 $task 置为 Disabled）。" -ForegroundColor Green
    }
    $node = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*src\server.js*' })
    if ($node.Count) {
        Write-Host "[提示] 服务仍在运行（PID $($node.ProcessId -join ',')），重启电脑后不会再自动启动。" -ForegroundColor Yellow
        Write-Host '       要立刻停掉：.\scripts\stop-service.ps1'
    }
    exit 0
}

# ---------- 开启自启 ----------
if (-not (Test-Path $vbs)) {
    Write-Host "[错误] 未找到 $vbs" -ForegroundColor Red
    exit 1
}

# 模式文件是服务启动时读的，先写它
$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
Set-Content -Path $modeFile -Value $Mode -Encoding ASCII -NoNewline
Write-Host "[1/2] 启动模式已写入 $modeFile -> $Mode" -ForegroundColor Cyan

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
    -Description "EasyBrowse (127.0.0.1:28471 -> zjc.rainplay.cn:25578)，开机模式=$Mode，frpc 由服务托管" -Force | Out-Null

# Register-ScheduledTask 重建后可能回到 Ready，显式确保启用
Enable-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null
Write-Host "[2/2] 计划任务 $task 已注册并启用（模式：$Mode）" -ForegroundColor Cyan

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*src\server.js*' })

if ($running.Count) {
    Write-Host "[提示] 服务正在运行 (PID $($running.ProcessId -join ','))，未重启以免中断在线用户。" -ForegroundColor Yellow
    Write-Host '       新模式的生效时机：下次开机，或执行 .\scripts\stop-service.ps1 -Restart'
} else {
    Start-ScheduledTask -TaskName $task
    Write-Host '[完成] 已按新模式拉起服务' -ForegroundColor Green
}

Write-Host ''
Write-Host '查看状态：.\scripts\stop-service.ps1 -Status'
Write-Host '停止服务：.\scripts\stop-service.ps1'
Write-Host '关闭自启：.\install-autostart.ps1 -Off'
