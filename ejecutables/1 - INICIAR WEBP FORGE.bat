@echo off
rem ============================================
rem  USO DIARIO - Abre la aplicacion
rem  Pregunta que version quieres usar
rem ============================================
setlocal
title WEBP FORGE - Lanzador
color 0B
echo.
echo   ============================================
echo      WEBP FORGE - Elige como abrir la app
echo   ============================================
echo.
echo    [1] App de ESCRITORIO (instalada)
echo        + Icono, ventana propia, se actualiza sola
echo        - Sin salida MP4 (Electron no trae H.264)
echo.
echo    [2] NAVEGADOR (Chrome)
echo        + TODO disponible, incluido MP4
echo        - Sin auto-actualizacion
echo.
choice /c 12 /n /m "   Elige [1/2]: "
if errorlevel 2 goto :chrome

rem --- [1] App de escritorio instalada ---
for %%P in ("%ProgramFiles%\WebP Forge\WebP Forge.exe" "%LocalAppData%\Programs\WebP Forge\WebP Forge.exe" "%LocalAppData%\Programs\webp-forge\WebP Forge.exe") do (
  if exist "%%~P" ( start "" "%%~P" & exit /b 0 )
)
echo.
echo   No encontre la app instalada. Abriendo en el navegador...
timeout /t 2 >nul

:chrome
set "APP=%~dp0..\webp-forge.html"
if not exist "%APP%" ( echo No se encontro webp-forge.html & pause & exit /b 1 )
for %%I in ("%APP%") do set "APP=%%~fI"
set "URL=file:///%APP:\=/%"
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if exist "%%~P" ( start "" "%%~P" --app="%URL%" & exit /b 0 )
)
for %%P in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if exist "%%~P" ( start "" "%%~P" --app="%URL%" & exit /b 0 )
)
start "" "%APP%"
exit /b 0
