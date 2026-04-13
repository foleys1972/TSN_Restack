@echo off
setlocal enabledelayedexpansion

REM Build a standalone Windows exe using pkg.
REM Output: dist\tsn-ssh-automation.exe
REM Runtime assets: dist\public\ (required), dist\data\ (writable)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Install Node.js first.
  exit /b 1
)

echo.
echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 exit /b 1

echo.
echo [2/4] Creating dist folder...
if not exist dist mkdir dist

echo.
echo [3/4] Building exe (this can take a few minutes the first time)...
call npx pkg -t node18-win-x64 -o dist\tsn-ssh-automation.exe index.js
if errorlevel 1 exit /b 1

echo.
echo [4/4] Copying runtime assets...
if exist dist\public rmdir /s /q dist\public
xcopy public dist\public /E /I /Y >nul

if not exist dist\data mkdir dist\data
if not exist dist\data\sites.json (
  echo {"sites": []} > dist\data\sites.json
)

if not exist dist\data\settings.json (
  echo {"sshPassword":"admin","clusterResetSafetyPassword":"969131"} > dist\data\settings.json
)

echo.
echo Done.
echo - Run: dist\tsn-ssh-automation.exe
echo - Then open: http://localhost:5177
endlocal
