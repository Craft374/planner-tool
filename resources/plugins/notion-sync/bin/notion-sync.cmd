@echo off
rem Windows cmd/PowerShell launcher. Requires Python 3.11+.
chcp 65001 >nul
where py >nul 2>&1 && (
  py -3 "%~dp0..\notion_sync\__main__.py" %*
  exit /b
)
python "%~dp0..\notion_sync\__main__.py" %*
