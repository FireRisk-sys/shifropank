@echo off
chcp 65001 >nul

REM Запускаем tuna в новом окне
start "Tuna" cmd /k "tuna http 3000"

REM Ждем 5 секунд
timeout /t 5 /nobreak >nul

REM Нажимаем 'c' для копирования ссылки
powershell -command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('c')"

REM Ждем 1 секунду
timeout /t 1 /nobreak >nul

REM Запускаем npm start в НОВОМ окне
start "Node Server" cmd /k "cd /d E:\Progect\Shifropanc && npm start"

echo Оба процесса запущены!
pause