@echo off
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  start "" "http://localhost:8765/"
  py -3 -m http.server 8765 --bind 127.0.0.1
  exit /b %errorlevel%
)
where python >nul 2>nul
if not errorlevel 1 (
  start "" "http://localhost:8765/"
  python -m http.server 8765 --bind 127.0.0.1
  exit /b %errorlevel%
)
echo Python 3 is missing. Install it or start this folder with VS Code Live Server.
pause
