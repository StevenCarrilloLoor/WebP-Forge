@echo off
title Subiendo WebP Forge a GitHub (automatico)
cd /d "%~dp0"
del /q GIT_OK.flag GIT_FAIL.flag 2>nul
echo ==== GIT %date% %time% ==== > git.log
where git >> git.log 2>&1
if errorlevel 1 ( echo NO_GIT > GIT_FAIL.flag & exit )
if not exist .git (
  git init >> git.log 2>&1
  git branch -M main >> git.log 2>&1
)
git remote remove origin >> git.log 2>&1
git remote add origin https://github.com/StevenCarrilloLoor/WebP-Forge.git >> git.log 2>&1
git add -A >> git.log 2>&1
git -c user.name="Steven Carrillo" -c user.email="stevencarrilloloor@gmail.com" commit -m "WebP Forge v1.4.0 - convertidor universal + app de escritorio Electron" >> git.log 2>&1
git fetch origin >> git.log 2>&1
git pull --rebase origin main >> git.log 2>&1
git push -u origin main >> git.log 2>&1
if errorlevel 1 ( echo PUSH_FAIL > GIT_FAIL.flag & exit )
echo OK > GIT_OK.flag
exit
