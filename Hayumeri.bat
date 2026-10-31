@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem pushd works with local drives, spaces, Cyrillic and UNC paths.
pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open the project folder.
    pause
    exit /b 1
)

if not exist "scripts\start.ps1" (
    echo [ERROR] Missing scripts\start.ps1
    popd
    pause
    exit /b 1
)

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" (
    echo [ERROR] Windows PowerShell 5.1 is required.
    popd
    pause
    exit /b 1
)

"%PS_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%CD%\scripts\start.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
popd
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Hayumeri failed to start. Exit code: %EXIT_CODE%
    echo Check logs\launch.log in the project folder.
    if /i not "%CI%"=="true" pause
)
exit /b %EXIT_CODE%
