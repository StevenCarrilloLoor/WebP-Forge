@echo off
rem ============================================
rem  USO DIARIO - Abre la aplicacion
rem ============================================
setlocal
title WEBP FORGE
set "APP=%~dp0..\webp-forge.html"
if not exist "%APP%" (
  echo No se encontro webp-forge.html en la carpeta del proyecto.
  pause
  exit /b 1
)
for %%I in ("%APP%") do set "APP=%%~fI"
set "URL=file:///%APP:\=/%"
rem --- Chrome en modo app (ventana propia) ---
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if exist "%%~P" ( start "" "%%~P" --app="%URL%" & exit /b 0 )
)
rem --- Edge en modo app ---
for %%P in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if exist "%%~P" ( start "" "%%~P" --app="%URL%" & exit /b 0 )
)
start "" "%APP%"
exit /b 0
