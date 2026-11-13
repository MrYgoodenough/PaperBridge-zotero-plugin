"""Check the real isolated launcher with only core wheels, never a model or user profile."""
import json
import os
from pathlib import Path
import subprocess
import sys

# Copy only the launcher into a temporary stage owned by this native test run.
LAUNCHER = Path(__file__).resolve().parents[1] / "backend/launcher.py"


def test_native_launcher_imports_core_wheels_and_keeps_utf8_paths(tmp_path):
    """Exercise native venv discovery, SQLite/TLS imports and UTF-8 pipes under -I -S."""
    stage = tmp_path / "engine space 中文"
    backend = stage / "backend"
    backend.mkdir(parents=True)
    (backend / "launcher.py").write_bytes(LAUNCHER.read_bytes())
    (backend / "server.py").write_text('''
"""Expose launcher state without starting a service or model."""
import json, os, sqlite3, ssl, sys
from pathlib import Path
import pymupdf
with pymupdf.open() as document:
    document.new_page()
    pages = len(document)
print(json.dumps({"text": "启动 中文", "pages": pages, "encoding": sys.stdout.encoding,
    "isolated": sys.flags.isolated, "no_site": sys.flags.no_site,
    "temporary": os.environ["TMPDIR"], "windows_temporary": os.environ.get("TEMP"),
    "tls": bool(ssl.OPENSSL_VERSION), "sqlite": bool(sqlite3.sqlite_version)}, ensure_ascii=False))
''', encoding="utf-8")
    temporary = stage / "job temporary"
    environment = dict(os.environ, PAPERBRIDGE_JOB_TMP=str(temporary))
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-I", "-S", "-B", str(backend / "launcher.py"), "server.py"],
        cwd=tmp_path, env=environment, capture_output=True, encoding="utf-8", check=False,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["text"] == "启动 中文" and report["pages"] == 1
    assert report["encoding"] == "utf-8"
    assert report["isolated"] == 1 and report["no_site"] == 1
    assert report["tls"] and report["sqlite"]
    assert Path(report["temporary"]) == temporary and temporary.is_dir()
    if os.name == "nt":
        assert Path(report["windows_temporary"]) == temporary
