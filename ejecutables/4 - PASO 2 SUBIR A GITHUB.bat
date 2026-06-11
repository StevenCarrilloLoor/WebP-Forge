@echo off
rem ============================================
rem  PUBLICACION - PASO 2 de 3
rem  Sube el codigo fuente al repositorio.
rem  (Esto NO publica la actualizacion: eso es el paso 3)
rem ============================================
title PASO 2/3 - Subir codigo a GitHub
cd /d "%~dp0.."
echo ==== GIT %date% %time% ==== > git.log
where git >> git.log 2>&1
if errorlevel 1 ( echo Git no esta instalado & pause & exit /b 1 )
if not exist .git (
  git init >> git.log 2>&1
  git branch -M main >> git.log 2>&1
  git remote add origin https://github.com/StevenCarrilloLoor/WebP-Forge.git >> git.log 2>&1
)
git add -A >> git.log 2>&1
set /p MSG=Describe brevemente los cambios (mensaje del commit):
git -c user.name="Steven Carrillo" -c user.email="stevencarrilloloor@gmail.com" commit -m "%MSG%" >> git.log 2>&1
git pull --rebase origin main >> git.log 2>&1
git push -u origin main >> git.log 2>&1
if errorlevel 1 ( echo FALLO el push - revisa git.log & pause & exit /b 1 )
echo.
echo ============================================================
echo  Codigo subido a GitHub.
echo  Siguiente (PASO 3): publica el release en
echo  https://github.com/StevenCarrilloLoor/WebP-Forge/releases/new
echo  siguiendo GUIA_DE_ACTUALIZACION.md
echo ============================================================
pause
