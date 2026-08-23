@echo off
cd /d "%~dp0"
taskkill /F /IM "LLM Chat Vault.exe" /T 2>nul
taskkill /F /IM "LLM Conversations Viewer.exe" /T 2>nul
taskkill /F /IM "electron.exe" /T 2>nul
start "" "%~dp0dist\win-unpacked\LLM Chat Vault.exe"
