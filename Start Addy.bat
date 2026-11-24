@echo off
cd /d "%~dp0"
title Addy server
echo Starting Addy. Keep this window open while people are using the app.
start "" http://localhost:8080
node --no-warnings=ExperimentalWarning server.js
pause
