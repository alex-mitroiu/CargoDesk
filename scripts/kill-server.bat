@echo off
setlocal

set PORT=3001
set FOUND=0

for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr /R "[ \t]:%PORT% .*LISTENING"') do (
    set FOUND=1
    echo Killing PID %%P ^(port %PORT%^)...
    taskkill /PID %%P /F >nul 2>&1
)

if "%FOUND%"=="0" (
    echo No process listening on port %PORT%.
)

endlocal
