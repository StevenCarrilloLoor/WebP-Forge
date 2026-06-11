@echo off
title Publicar actualizacion de WebP Forge en GitHub
cd /d "%~dp0desktop"
copy /y "..\webp-forge.html" "webp-forge.html" >nul
if "%GH_TOKEN%"=="" (
  echo Necesitas un token de GitHub con scope "repo".
  set /p GH_TOKEN=Pega tu GH_TOKEN aqui:
)
echo Recuerda haber subido la version en desktop\package.json antes de publicar.
call npm run publish
if errorlevel 1 ( echo Fallo la publicacion & pause & exit /b 1 )
echo.
echo Release publicado en https://github.com/StevenCarrilloLoor/WebP-Forge/releases
echo Las apps instaladas se actualizaran solas al siguiente arranque.
pause
