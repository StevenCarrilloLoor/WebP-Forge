@echo off
rem ============================================
rem  CONFIGURACION - Crea acceso directo en el
rem  escritorio con el icono de la app (1 vez)
rem ============================================
title Crear acceso directo en el escritorio
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\WebP Forge.lnk'); $lnk.TargetPath='%~dp01 - INICIAR WEBP FORGE.bat'; $lnk.IconLocation='%~dp0..\desktop\icon.ico'; $lnk.WorkingDirectory='%~dp0'; $lnk.Description='WebP Forge - Convertidor universal'; $lnk.Save()"
echo Acceso directo "WebP Forge" creado en tu escritorio.
pause
