@echo off
title Construyendo WebP Forge (automatico)
cd /d "%~dp0desktop"
del /q "%~dp0BUILD_OK.flag" "%~dp0BUILD_FAIL.flag" 2>nul
copy /y "..\webp-forge.html" "webp-forge.html" >nul
echo ==== BUILD %date% %time% ==== > build.log
echo [1/2] npm install... >> build.log
call npm install >> build.log 2>&1
if errorlevel 1 ( echo NPM_INSTALL_FAIL > "%~dp0BUILD_FAIL.flag" & exit )
echo [2/2] electron-builder... >> build.log
call npm run dist >> build.log 2>&1
if errorlevel 1 ( echo DIST_FAIL > "%~dp0BUILD_FAIL.flag" & exit )
echo OK > "%~dp0BUILD_OK.flag"
exit
