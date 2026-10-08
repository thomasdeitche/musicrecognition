@echo off
title Musikerkennung
rem pushd statt cd, damit der Ordner auch von einem Netzlaufwerk/UNC-Pfad laeuft
pushd "%~dp0"

rem Mitgeliefertes Node bevorzugen, sonst installiertes Node verwenden
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

rem Laeuft der Server schon? Dann nur den Browser oeffnen.
netstat -ano | findstr /r /c:"127.0.0.1:3000 .*LISTENING" >nul
if not errorlevel 1 (
  start "" http://localhost:3000/
  popd
  exit /b
)

rem Browser erst nach 2 Sekunden oeffnen, damit der Server bereit ist
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:3000/"
"%NODE%" server.js
popd
pause
