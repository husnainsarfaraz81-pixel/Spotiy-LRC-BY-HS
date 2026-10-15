@echo off
title Spotify -^> Synced Lyrics
cd /d %~dp0
echo.
echo  Spotify -^> Synced Lyrics start ho raha hai...
echo  Band karne ke liye ye window close kar do ya Ctrl+C dabao.
echo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
node server.js
pause
