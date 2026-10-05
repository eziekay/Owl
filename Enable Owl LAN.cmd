@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-Owl-LAN.ps1"
if errorlevel 1 pause
