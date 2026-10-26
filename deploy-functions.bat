@echo off
cd /d "%~dp0"
call npm --prefix functions install
firebase deploy --only functions
firebase functions:list
pause
