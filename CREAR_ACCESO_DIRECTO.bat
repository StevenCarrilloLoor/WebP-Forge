@echo off
title Crear acceso directo en el escritorio
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\WebP Forge.lnk'); $lnk.TargetPath='%~dp0INICIAR WEBP FORGE.bat'; $lnk.IconLocation='%~dp0desktop\icon.ico'; $lnk.WorkingDirectory='%~dp0'; $lnk.Description='WebP Forge - Convertidor universal'; $lnk.Save()"
echo Acceso directo "WebP Forge" creado en tu escritorio.
pause
