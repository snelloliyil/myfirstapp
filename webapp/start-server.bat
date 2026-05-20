@echo off
set PORT=5081

echo Checking for existing server on port %PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo Stopping process %%a on port %PORT%...
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting server...
cd /d "%~dp0"
start "Webapp Server" /B node server.js

timeout /t 2 /nobreak >nul

echo.
echo Server started at http://localhost:%PORT%
echo.
echo Available endpoints:
echo   GET /                        - Main UI
echo   GET /api/ticket/:id          - Single work item by ID
echo   GET /api/tickets             - List tickets (with filters)
echo   GET /api/search?q=^<keyword^>  - Search tickets
echo.
