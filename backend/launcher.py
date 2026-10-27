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
if os.name == "nt":
    # Windows programs read TMP/TEMP, not TMPDIR; keep every temporary file inside the job.
    os.environ["TMP"] = os.environ["TEMP"] = str(temporary)
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
sys.dont_write_bytecode = True
# Engine output is line-oriented JSON that may contain the user's language; never rely on
# the console code page (cp936/cp1252 on Windows, ASCII in some launch contexts).
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")
# A bundled CPython keeps its standard library and third-party packages in different
# directories on each platform: Lib/site-packages on Windows, lib/python3.12/... elsewhere.
# Development checkouts have no bundled interpreter, so the virtual environment that runs
# us - hidden by isolated mode - supplies the dependencies instead.
SITE_PACKAGES = "Lib/site-packages" if os.name == "nt" else "lib/python3.12/site-packages"


def development_packages():
    """site-packages of the virtual environment that owns this interpreter, if any."""
    environment = Path(sys.executable).parent.parent
    candidate = environment / SITE_PACKAGES
    if (environment / "pyvenv.cfg").is_file() and candidate.is_dir():
        return candidate
    return None


sys.path[:0] = [str(ROOT / "backend")]
for candidate in (ROOT / "python" / SITE_PACKAGES, development_packages()):
    if candidate and candidate.is_dir():
        sys.path.append(str(candidate))
        break
else:
    import site

    sys.path.extend(site.getsitepackages())
if __name__ == "__main__":
    target = sys.argv.pop(1)
    if target not in {"server.py", "engine.py"}:
        raise ValueError("Unknown engine entry point")
    sys.argv[0] = str(ROOT / "backend" / target)
    runpy.run_path(sys.argv[0], run_name="__main__")
