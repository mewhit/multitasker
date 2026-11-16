@echo off
setlocal
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\setup-wizard.ps1"
exit /b %ERRORLEVEL%
