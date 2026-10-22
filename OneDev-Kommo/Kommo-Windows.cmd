@echo off
rem One Development: add Kommo to the connector - Windows. Double-click. Mail and ai-office are not touched.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%USERPROFILE%\.onedev-connector\node\node.exe"
if not exist "%NODE%" set "NODE="
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE goto nonode
"%NODE%" payload\add-kommo.mjs
pause
exit /b
:nonode
echo Node.js not found - the One Development connector is not installed. Please write to Dmitry.
pause
