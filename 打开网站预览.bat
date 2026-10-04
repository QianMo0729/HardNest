@echo off
cd /d "%~dp0"
start "preview-server" /min node preview-server.js
timeout /t 1 /nobreak >nul
start "" "http://localhost:8931/Home.dc.html"
echo.
echo Preview server is running in a minimized window.
echo Close that window to stop the server.
pause
