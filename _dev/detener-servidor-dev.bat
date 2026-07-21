@echo off
rem Detiene el servidor de desarrollo (ventana WF-DEV-SERVER)
taskkill /f /fi "WINDOWTITLE eq WF-DEV-SERVER*" >nul 2>&1
echo Servidor detenido (si estaba corriendo).
timeout /t 2 >nul
