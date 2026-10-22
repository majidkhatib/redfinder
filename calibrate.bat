@echo off
cd /d "%~dp0"
python red_detector.py --calibrate %*
pause
