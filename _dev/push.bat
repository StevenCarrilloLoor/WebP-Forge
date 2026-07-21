@echo off
rem DESARROLLO - push no interactivo (los commits ya estan hechos)
title WF-PUSH
cd /d "%~dp0.."
echo ==== PUSH %date% %time% ==== > "%~dp0push.log"
git pull --rebase origin main >> "%~dp0push.log" 2>&1
git push -u origin main >> "%~dp0push.log" 2>&1
echo EXIT %errorlevel% >> "%~dp0push.log"
exit /b 0
