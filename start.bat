@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   EasyBrowse 多用户远程浏览器平台
echo ==========================================

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
echo.
node --experimental-sqlite src/server.js

echo.
echo 服务已退出。
pause
