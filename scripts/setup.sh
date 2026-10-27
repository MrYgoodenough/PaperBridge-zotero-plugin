#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export UV_CACHE_DIR="$PWD/.cache/uv"
export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python"
export UV_PYTHON_CACHE_DIR="$PWD/.cache/python"
export TMPDIR="$PWD/.runtime/tmp"
mkdir -p "$TMPDIR" .tools
if command -v uv >/dev/null 2>&1; then
  UV=$(command -v uv)
elif [ -x .tools/bin/uv ]; then
  UV="$PWD/.tools/bin/uv"
else
  python3 -m pip install --target .tools --cache-dir .cache/pip uv
  UV="$PWD/.tools/bin/uv"
fi
"$UV" sync --python 3.12
.venv/bin/python backend/fonts.py
printf '\n开发环境就绪。运行 .venv/bin/python scripts/stage_runtime.py，再运行 .venv/bin/python scripts/build.py 构建完整 XPI。\n'
