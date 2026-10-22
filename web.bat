@echo off
cd /d "%~dp0"
echo Open http://localhost:8000/web/ in Chrome, Edge or Firefox. Close this window to stop.
start "" http://localhost:8000/web/
python -m http.server 8000 --bind 127.0.0.1
