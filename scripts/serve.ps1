# Run the development bridge (mirrors scripts/serve.sh).
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
& ".\.venv\Scripts\python.exe" backend\server.py @args
