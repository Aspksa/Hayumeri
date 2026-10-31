@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
 echo [ERROR] Cannot access Hayumeri folder.
 exit /b 1
)
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" (
 echo [ERROR] Windows PowerShell not found.
 popd
 exit /b 1
)
if not exist "scripts\databases.ps1" (
 echo [ERROR] Missing scripts\databases.ps1
 popd
 exit /b 1
)
set "DB_ACTION=%~1"
if not defined DB_ACTION set "DB_ACTION=start"
"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\databases.ps1" -Action "%DB_ACTION%"
set "EXIT_CODE=%ERRORLEVEL%"
popd
if not "%EXIT_CODE%"=="0" (
 echo [ERROR] Database command failed. Exit code: %EXIT_CODE%
 if /i not "%CI%"=="true" pause
)
exit /b %EXIT_CODE%
