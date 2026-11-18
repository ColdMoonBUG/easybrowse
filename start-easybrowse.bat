@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title EasyBrowse - full platform

rem ============================================================
rem  Full platform: login, workspace, admin console, remote browser,
rem  screen and audio channels. Overrides NOWAPI_ONLY so a previous
rem  light-mode setting never leaks in.
rem
rem  KEEP THIS FILE ASCII-ONLY. Under chcp 65001 cmd.exe mis-parses
rem  consecutive multi-byte lines in a batch file and drops them
rem  (reproduced: the 3rd Chinese echo line vanished and cmd tried
rem  to execute a fragment). English here, UTF-8 in Node's own log.
rem ============================================================
set NOWAPI_ONLY=0

echo ==========================================
echo   EasyBrowse - full platform
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

echo [2/2] Starting the full platform...
echo       Press Ctrl+C to stop
echo       Port already in use? run scripts\stop-service.ps1 first
echo.
node --experimental-sqlite src/server.js

echo.
echo Service exited.
pause
