@echo off
rem DESARROLLO - Lanza la build win-unpacked con logging de Electron a archivo
taskkill /f /im "WebP Forge.exe" >nul 2>&1
timeout /t 1 >nul
set "LOG=%~dp0electron.log"
del /q "%LOG%" 2>nul
start "" "%~dp0..\desktop\dist\win-unpacked\WebP Forge.exe" --enable-logging=file --log-file="%LOG%"
exit /b 0
