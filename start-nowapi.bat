@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title EasyBrowse - nowapi only

rem ============================================================
rem  Light mode: only /nowapi is served. Pages, APIs, static files
rem  and the screen WebSocket all return 404. No remote browser.
rem  The variable below overrides .env, no config edit needed.
rem
rem  KEEP THIS FILE ASCII-ONLY. Under chcp 65001 cmd.exe mis-parses
rem  consecutive multi-byte lines in a batch file and drops them
rem  (reproduced: the 3rd Chinese echo line vanished and cmd tried
rem  to execute a fragment). English here, UTF-8 in Node's own log.
rem ============================================================
set NOWAPI_ONLY=1

echo ==========================================
echo   EasyBrowse - nowapi only mode
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22 or newer first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/2] First run, installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check network or npm registry.
    pause
    exit /b 1
  )
)

if not exist .env (
  if exist .env.example (
    copy .env.example .env >nul
    echo [INFO] Created .env from .env.example
  )
)

echo [2/2] Starting: only /nowapi is served, everything else 404
echo       Remote browser feature is off; frpc is managed by the service
echo       Press Ctrl+C to stop
echo       Port already in use? run scripts\stop-service.ps1 first
echo.
node --experimental-sqlite src/server.js

echo.
echo Service exited.
pause
