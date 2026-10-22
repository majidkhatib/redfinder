@echo off
cd /d "%~dp0"
python -m pip install --quiet numpy scipy soundfile pyaudiowpatch
python red_detector.py %*
pause
