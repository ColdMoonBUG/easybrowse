# 停止 / 重启 EasyBrowse 平台（含它托管的 frpc）
#
# 为什么需要这个脚本：
#   start-hidden.vbs 现在是守护模式——node 非正常退出会被 5 秒后自动拉起，
#   所以直接 Stop-Process 杀 node 是没用的，必须先把守护进程（wscript）结束掉。
#
# 用法：
#   .\scripts\stop-service.ps1            停止
#   .\scripts\stop-service.ps1 -Restart   重启（停完立刻用计划任务拉起）
#   .\scripts\stop-service.ps1 -Status    只看状态，不动手
#
# 若直接双击运行，可能因执行策略被拦：powershell -ExecutionPolicy Bypass -File .\scripts\stop-service.ps1

param(
  [switch]$Restart,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$task = 'easybrowse-app'
$frpcToml = 'frpc-webproxy.toml'

function Get-ServiceNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*src\server.js*' }
}

function Get-Guardian {
  Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*start-hidden.vbs*' }
}

function Show-Status {
  $g = @(Get-Guardian)
  $n = @(Get-ServiceNode)
  $f = @(Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like "*$frpcToml*" })
  $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue

  Write-Host "计划任务    : $($t.State)"
  Write-Host "守护进程    : $(if ($g.Count) { ($g.ProcessId -join ',') + '  (守护模式已启用)' } else { '无  (说明当前是旧的一次性启动方式)' })"
  Write-Host "node 服务   : $(if ($n.Count) { ($n.ProcessId -join ',') } else { '未运行' })"
  Write-Host "frpc 进程   : $(if ($f.Count) { ($f.ProcessId -join ',') } else { '未运行' })"
}

if ($Status) {
  Show-Status
  return
}

Write-Host "[1/4] 结束守护进程（否则 node 会被自动拉起）..."
$guardians = @(Get-Guardian)
if ($guardians.Count) {
  foreach ($p in $guardians) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "      结束 wscript PID $($p.ProcessId)" }
} else {
  Write-Host "      没有守护进程在跑，跳过"
}
try { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue } catch { }

Write-Host "[2/4] 结束 node 服务..."
$nodes = @(Get-ServiceNode)
if ($nodes.Count) {
  foreach ($p in $nodes) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "      结束 node PID $($p.ProcessId)" }
} else {
  Write-Host "      没有 node 服务在跑，跳过"
}

Write-Host "[3/4] 清理残留 frpc（node 被强杀时它不会自己退出）..."
Start-Sleep -Milliseconds 800
$frpcs = @(Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like "*$frpcToml*" })
if ($frpcs.Count) {
  foreach ($p in $frpcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "      结束 frpc PID $($p.ProcessId)" }
} else {
  Write-Host "      没有残留 frpc，跳过"
}

if ($Restart) {
  Write-Host "[4/4] 重新拉起（守护模式）..."
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 3
  Show-Status
} else {
  Write-Host "[4/4] 已停止。重新启动：Start-ScheduledTask -TaskName $task"
}
