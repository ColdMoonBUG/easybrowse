@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title EasyBrowse - 仅 /nowapi

rem 极简模式：只开放 /nowapi，页面 / 接口 / WebSocket 全部 404，远端浏览器不启动。
rem 这里显式设环境变量，优先级高于 .env，所以不用改配置文件。
set NOWAPI_ONLY=1

echo ==========================================
echo   EasyBrowse - 极简模式（只开放 /nowapi）
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
    echo [提示] 已根据 .env.example 生成 .env，可按需修改端口与代理路径。
  )
)

echo [2/2] 启动中：只响应 /nowapi，其余路径一律 404
echo       远端浏览器功能已关闭；frpc 由服务托管，随本窗口一起退出
echo       按 Ctrl+C 停止
echo       若提示端口被占用，先运行 scripts\stop-service.ps1 停掉正在跑的实例
echo.
node --experimental-sqlite src/server.js

echo.
echo 服务已退出。
pause
