@echo off
chcp 65001 >nul
rem Локальная проверка сайта. Браузер не запускает JS-модули прямо из файла,
rem поэтому поднимаем маленький веб-сервер из этой папки. Нужен Python.
cd /d "%~dp0"
echo Сайт комнаты: http://localhost:8090/
echo Чтобы остановить - закройте это окно.
start "" "http://localhost:8090/"
where python >nul 2>nul && (python -m http.server 8090 --bind 127.0.0.1) || (py -m http.server 8090 --bind 127.0.0.1)
pause
