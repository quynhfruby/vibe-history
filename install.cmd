@echo off
REM Double-clickable Windows launcher for install.ps1.
REM Runs the PowerShell installer with an execution-policy bypass for this run only.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
