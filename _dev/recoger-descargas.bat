@echo off
rem DESARROLLO - Mueve los archivos de prueba convertidos desde Descargas
rem a _dev\salidas-prueba\ para poder verificarlos con herramientas externas.
set "DEST=%~dp0salidas-prueba"
if not exist "%DEST%" mkdir "%DEST%"
for %%F in ("animated.mp4" "anim.webm" "video.mp4" "video.webm.mp4" "webp-forge-convertidos.zip") do (
  if exist "%USERPROFILE%\Downloads\%%~F" move /y "%USERPROFILE%\Downloads\%%~F" "%DEST%\" >nul
)
dir /b "%DEST%" > "%DEST%\_contenido.log" 2>&1
exit /b 0
