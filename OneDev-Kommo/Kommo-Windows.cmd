@echo off
rem One Development: Kommo for Claude - Windows. Double-click, or "Kommo-Windows.cmd auto" (no pause at the end).
chcp 65001 >nul
cd /d "%~dp0"
rem Windows PowerShell must not inherit PowerShell 7 module paths.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0payload\install-win.ps1"
set "RC=%ERRORLEVEL%"
if /i not "%~1"=="auto" pause
exit /b %RC%
