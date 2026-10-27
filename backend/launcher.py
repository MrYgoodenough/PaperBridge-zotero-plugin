"""Use only the selected interpreter's standard library and the bundled packages."""
import runpy
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
temporary = Path(os.environ.get("PAPERBRIDGE_JOB_TMP",
                 str(Path(os.environ.get("PAPERBRIDGE_STATE_DIR", ROOT / ".runtime")) / "tmp")))
temporary.mkdir(parents=True, exist_ok=True)
os.environ["TMPDIR"] = str(temporary)
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "python/lib/python3.12/site-packages")]
if __name__ == "__main__":
    target = sys.argv.pop(1)
    if target not in {"server.py", "engine.py"}:
        raise ValueError("Unknown engine entry point")
    sys.argv[0] = str(ROOT / "backend" / target)
    runpy.run_path(sys.argv[0], run_name="__main__")
