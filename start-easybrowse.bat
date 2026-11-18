@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title EasyBrowse - 完整平台

rem 完整平台：登录页、用户工作区、管理后台、远端浏览器、画面与音频通道全部开启。
rem 显式覆盖 .env 里的 NOWAPI_ONLY，避免上次设置的极简模式残留。
set NOWAPI_ONLY=0

echo ==========================================
echo   EasyBrowse 多用户远程浏览器平台
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或 npm 镜像设置。
    pause
    exit /b 1
  )
)

if not exist .env (
  if exist .env.example (
    copy .env.example .env >nul
    echo [提示] 已根据 .env.example 生成 .env，可按需修改端口与浏览器路径。
  )
)

echo [2/2] 正在启动服务... 按 Ctrl+C 停止
echo       若提示端口被占用，先运行 scripts\stop-service.ps1 停掉正在跑的实例
echo.
node --experimental-sqlite src/server.js

echo.
echo 服务已退出。
pause
