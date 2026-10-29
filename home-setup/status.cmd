@echo off
rem Double-click to see download progress. Ctrl+C (or close the window) to stop watching;
rem the download itself keeps running.
chcp 65001 >nul
cd /d "%~dp0"
if exist logs\DONE echo ===== DONE: download finished =====
if exist logs\FAILED (
    echo ===== FAILED: download stopped. Details below =====
    type logs\FAILED
    pause
    exit /b
)
echo Live log below. "start ..." / "done ..." lines show the current step.
echo.
wsl -d Ubuntu-24.04 --cd "%~dp0.." -- tail -n 15 -f home-setup/logs/download.log
