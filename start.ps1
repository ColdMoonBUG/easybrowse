# EasyBrowse 启动脚本（PowerShell）
# 用法：右键「使用 PowerShell 运行」，或在终端执行 .\start.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  EasyBrowse 多用户远程浏览器平台' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[错误] 未找到 Node.js，请先安装 Node.js 22 或更高版本。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

if (-not (Test-Path 'node_modules')) {
    Write-Host '[1/2] 首次运行，正在安装依赖...' -ForegroundColor Yellow
    npm install
}

if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
    Copy-Item '.env.example' '.env'
    Write-Host '[提示] 已生成 .env，可按需修改端口与浏览器路径。' -ForegroundColor Yellow
}

Write-Host '[2/2] 正在启动服务，按 Ctrl+C 停止' -ForegroundColor Green
node --experimental-sqlite src/server.js
