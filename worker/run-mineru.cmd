@echo off
rem Keeps the MinerU API running in WSL: restarts it 30 s after any exit.
rem Started at logon by the "mdbeaver mineru" scheduled task (see worker/install-autostart.ps1).
cd /d "%~dp0.."
:loop
wsl.exe -d Ubuntu-24.04 --cd "%CD%" -- bash worker/mineru-server.sh
ping -n 31 127.0.0.1 >nul
goto loop
