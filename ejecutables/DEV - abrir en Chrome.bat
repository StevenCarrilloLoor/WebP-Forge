@echo off
rem ============================================
rem  DESARROLLO - Abre webp-forge.html en Chrome
rem  directamente (sin preguntar), para probar
rem  cambios antes de construir el .exe
rem ============================================
set "APP=%~dp0..\webp-forge.html"
if not exist "%APP%" ( echo No se encontro webp-forge.html & pause & exit /b 1 )
for %%I in ("%APP%") do set "APP=%%~fI"
set "URL=file:///%APP:\=/%"
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if exist "%%~P" ( start "" "%%~P" "%URL%" & exit /b 0 )
)
start "" "%APP%"
exit /b 0
