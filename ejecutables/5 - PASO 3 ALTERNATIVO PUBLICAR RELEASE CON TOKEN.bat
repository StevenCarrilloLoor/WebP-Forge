@echo off
rem ============================================
rem  PUBLICACION - PASO 3 (ALTERNATIVA AUTOMATICA)
rem  Publica el release con todo incluido usando un
rem  token de GitHub. Si prefieres hacerlo manual y
rem  seguro desde la web, NO uses este: sigue la
rem  GUIA_DE_ACTUALIZACION.md
rem ============================================
title PASO 3 (alternativo) - Publicar release con token
cd /d "%~dp0..\desktop"
copy /y "..\webp-forge.html" "webp-forge.html" >nul
if "%GH_TOKEN%"=="" (
  echo Necesitas un token de GitHub con scope "repo".
  set /p GH_TOKEN=Pega tu GH_TOKEN aqui:
)
call npm run publish
if errorlevel 1 ( echo Fallo la publicacion & pause & exit /b 1 )
echo Release publicado en https://github.com/StevenCarrilloLoor/WebP-Forge/releases
pause
