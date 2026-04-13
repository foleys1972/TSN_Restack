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
call npx pkg -t node18-win-x64 -o dist\tsn-ssh-automation.tmp.exe index.js
if errorlevel 1 exit /b 1

echo.
echo Replacing dist\tsn-ssh-automation.exe ...
copy /Y dist\tsn-ssh-automation.tmp.exe dist\tsn-ssh-automation.exe >nul
if errorlevel 1 (
  echo.
  echo ERROR: Could not overwrite dist\tsn-ssh-automation.exe.
  echo - Make sure the EXE is not currently running.
  echo - If Windows Defender/AV is scanning it, wait a moment and retry.
  exit /b 1
)
del /Q dist\tsn-ssh-automation.tmp.exe >nul 2>nul

echo.
echo [4/4] Copying runtime assets...
if exist dist\public rmdir /s /q dist\public
xcopy public dist\public /E /I /Y >nul

if not exist dist\data mkdir dist\data
if not exist dist\data\sites.json (
  echo {"sites": []} > dist\data\sites.json
)

if not exist dist\data\settings.json (
  echo {"sshPassword":"admin"} > dist\data\settings.json
)

echo.
echo Done.
echo - Run: dist\tsn-ssh-automation.exe
echo - Then open: http://localhost:5177
endlocal
