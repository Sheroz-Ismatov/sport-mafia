@echo off
cd /d "%~dp0"
set TIMER_SCALE=0.2
node server\index.ts
pause
