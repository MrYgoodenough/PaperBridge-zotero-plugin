#!/bin/sh
# Prepare the project environment and platform-specific runtime assets.
set -eu
cd "$(dirname "$0")/.."
export UV_CACHE_DIR="$PWD/.cache/uv"
export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python"
export UV_PYTHON_CACHE_DIR="$PWD/.cache/python"
export TMPDIR="$PWD/.runtime/tmp"
# Linux packaging currently targets GNU amd64.
task_os=$(uname -s)
task_arch=$(uname -m)
mkdir -p "$TMPDIR" .tools/bin
if command -v uv >/dev/null 2>&1 && uv --version >/dev/null 2>&1; then
  UV=$(command -v uv)
elif [ -x .tools/bin/uv ] && .tools/bin/uv --version >/dev/null 2>&1; then
  UV="$PWD/.tools/bin/uv"
elif [ "$task_os" = "Linux" ]; then
  case "$task_arch" in
    x86_64|amd64) ;;
    *) printf 'Unsupported Linux architecture: %s\n' "$task_arch" >&2; exit 1 ;;
  esac
  # The official standalone binary needs neither system Python nor global pip.
  task_uv_url="https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz"
  task_uv_archive="$TMPDIR/uv-x86_64-unknown-linux-gnu.tar.gz"
  curl -fL "$task_uv_url" -o "$task_uv_archive"
  tar -xzf "$task_uv_archive" -C .tools/bin --strip-components=1 uv-x86_64-unknown-linux-gnu/uv
  UV="$PWD/.tools/bin/uv"
else
  python3 -m pip install --target .tools --cache-dir .cache/pip uv
  UV="$PWD/.tools/bin/uv"
fi
if [ "$task_os" = "Linux" ]; then
  # Keep inherited ROS/Conda Python settings outside this project's environment.
  unset PYTHONHOME PYTHONPATH LD_LIBRARY_PATH LD_PRELOAD
  export UV_PROJECT_ENVIRONMENT="$PWD/.venv"
  # Avoid user-level Python links and select the managed base interpreter explicitly.
  "$UV" python install 3.12 --no-bin
  task_python=$("$UV" python find --managed-python --system 3.12)
  "$UV" sync --locked --managed-python --python "$task_python"
  .venv/bin/python scripts/warmup.py
else
  "$UV" sync --python 3.12
  .venv/bin/python backend/fonts.py
fi
printf '\n开发环境就绪。运行 .venv/bin/python scripts/stage_runtime.py，再运行 .venv/bin/python scripts/build.py 构建完整 XPI。\n'
