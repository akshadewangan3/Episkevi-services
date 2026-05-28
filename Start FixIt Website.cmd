@echo off
cd /d "%~dp0"
echo Starting FixIt at http://localhost:3000
echo Admin API key defaults to: change-this-secret
echo For publishing, set FIXIT_API_KEY to your own strong secret.
start "" "http://localhost:3000"
npm start
