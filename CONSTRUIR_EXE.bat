@echo off
title Construir WebP Forge .exe
cd /d "%~dp0desktop"
copy /y "..\webp-forge.html" "webp-forge.html" >nul
where npm >nul 2>nul
if errorlevel 1 (
  echo No se encontro npm. Instala Node.js desde nodejs.org y reintenta.
  pause
  exit /b 1
)
echo [1/2] Instalando dependencias (solo la primera vez, necesita internet)...
call npm install
if errorlevel 1 ( echo Fallo npm install & pause & exit /b 1 )
echo [2/2] Generando instalador y portable...
call npm run dist
if errorlevel 1 ( echo Fallo la construccion & pause & exit /b 1 )
echo.
echo ============================================================
echo  LISTO. Revisa la carpeta:  desktop\dist
echo    - WebP-Forge-Setup-*.exe      (instalador con auto-update)
echo    - WebP-Forge-Portable-*.exe   (ejecutable suelto)
echo ============================================================
pause
