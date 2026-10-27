# Prepare the Windows development environment (mirrors scripts/setup.sh).
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:UV_CACHE_DIR = Join-Path $PWD ".cache/uv"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PWD ".tools/python"
$env:UV_PYTHON_CACHE_DIR = Join-Path $PWD ".cache/python"
$env:TMPDIR = Join-Path $PWD ".runtime/tmp"
New-Item -ItemType Directory -Force -Path $env:TMPDIR, ".tools" | Out-Null

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv -and (Test-Path ".tools\bin\uv.exe")) { $uv = (Resolve-Path ".tools\bin\uv.exe").Path }
if (-not $uv) {
  python -m pip install --target .tools --cache-dir .cache/pip uv
  $uv = (Resolve-Path ".tools\bin\uv.exe").Path
}
& $uv sync --python 3.12
if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

& ".\.venv\Scripts\python.exe" scripts\warmup.py
if ($LASTEXITCODE -ne 0) { throw "warmup failed" }

Write-Host "Development environment ready. Run .venv\Scripts\python.exe scripts\stage_runtime.py, then scripts\build.py to build the full XPI."
