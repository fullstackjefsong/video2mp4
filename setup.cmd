@echo off
rem One-step installer for video2mp4 on Windows (cmd / double-click friendly).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
set "EXITCODE=%ERRORLEVEL%"
if /i "%~1" neq "/quiet" pause
exit /b %EXITCODE%
