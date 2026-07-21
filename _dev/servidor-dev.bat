@echo off
rem ============================================
rem  DESARROLLO - Servidor local para probar la
rem  app en Chrome: http://localhost:8765/webp-forge.html
rem  Cierra esta ventana (o usa detener-servidor-dev.bat)
rem  para apagarlo. Solo escucha en 127.0.0.1.
rem ============================================
title WF-DEV-SERVER
cd /d "%~dp0.."
echo Servidor en http://localhost:8765/webp-forge.html
py -m http.server 8765 --bind 127.0.0.1 2>nul || python -m http.server 8765 --bind 127.0.0.1
