@echo off
rem ============================================
rem  PUBLICACION - PASO 1 de 3
rem  Construye el instalador y el portable.
rem  ANTES: sube la version en desktop\package.json
rem ============================================
title PASO 1/3 - Construir WebP Forge .exe
cd /d "%~dp0..\desktop"
del /q "%~dp0BUILD_OK.flag" "%~dp0BUILD_FAIL.flag" 2>nul
copy /y "..\webp-forge.html" "webp-forge.html" >nul
echo ==== BUILD %date% %time% ==== > build.log
echo [1/2] Instalando dependencias (solo tarda la primera vez)...
call npm install >> build.log 2>&1
if errorlevel 1 ( echo FALLO npm install - revisa desktop\build.log & echo NPM_FAIL > "%~dp0BUILD_FAIL.flag" & pause & exit /b 1 )
echo [2/2] Construyendo instalador y portable...
call npm run dist >> build.log 2>&1
if errorlevel 1 ( echo FALLO la construccion - revisa desktop\build.log & echo DIST_FAIL > "%~dp0BUILD_FAIL.flag" & pause & exit /b 1 )
echo OK > "%~dp0BUILD_OK.flag"
echo.
echo ============================================================
echo  LISTO. Los archivos para el release estan en: desktop\dist
echo    - WebP-Forge-Setup-X.X.X.exe
echo    - WebP-Forge-Setup-X.X.X.exe.blockmap
echo    - latest.yml
echo    - WebP-Forge-Portable-X.X.X.exe
echo  Siguiente: ejecuta "4 - PASO 2 SUBIR A GITHUB.bat"
echo ============================================================
pause
