@echo off
rem Launch Codex with full Chromium logging enabled.
rem ELECTRON_ENABLE_LOGGING/ELECTRON_LOG_FILE work for the browser process
rem itself, unlike appendSwitch which only affects child processes.

if not exist "%LOCALAPPDATA%\CodexForensics" mkdir "%LOCALAPPDATA%\CodexForensics"

set ELECTRON_ENABLE_LOGGING=file
set ELECTRON_LOG_FILE=%LOCALAPPDATA%\CodexForensics\chrome-debug.log

rem 优先使用 out-fix（out/ 被 IDE 锁定时的替代输出目录）
set CODEX_EXE=%~dp0..\out-fix\win\Codex-win32-x64\Codex.exe
if not exist "%CODEX_EXE%" set CODEX_EXE=%~dp0..\out\win\Codex-win32-x64\Codex.exe

start "" "%CODEX_EXE%"
echo Codex launched: %CODEX_EXE%
echo Chromium logging to:
echo   %LOCALAPPDATA%\CodexForensics\chrome-debug.log
