@echo off
setlocal
title WEBP FORGE
set "APP=%~dp0webp-forge.html"
if not exist "%APP%" (
  echo No se encontro webp-forge.html junto a este lanzador.
  pause
  exit /b 1
)
rem --- Preferir Chrome ---
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if exist "%%~P" ( start "" "%%~P" "%APP%" & exit /b 0 )
)
rem --- Luego Edge ---
for %%P in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if exist "%%~P" ( start "" "%%~P" "%APP%" & exit /b 0 )
)
rem --- Navegador por defecto ---
start "" "%APP%"
exit /b 0
