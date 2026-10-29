@echo off
rem Keeps the worker running: restarts it 10 s after any exit (crash, network loss, update).
rem Started at logon by the "mdbeaver worker" scheduled task (see worker/install-autostart.ps1).
cd /d "%~dp0"
:loop
".venv\Scripts\python.exe" -u worker.py 2>> worker.log
ping -n 11 127.0.0.1 >nul
goto loop
