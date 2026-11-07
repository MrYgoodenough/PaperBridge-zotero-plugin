#!/bin/sh
# Launch only the project's interpreter without inherited Python settings.
set -eu
cd "$(dirname "$0")/.."
unset PYTHONHOME PYTHONPATH
if [ "$(uname -s)" = "Linux" ]; then
  # ROS/Conda libraries belong to their own processes, not this PDF engine.
  unset LD_LIBRARY_PATH LD_PRELOAD
fi
exec .venv/bin/python backend/server.py "$@"
