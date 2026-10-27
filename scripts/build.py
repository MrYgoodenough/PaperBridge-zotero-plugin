"""Build a standalone XPI with a platform-specific Python engine and model."""
import hashlib
import argparse
import json
import platform
import shutil
import sys
import zipfile
from pathlib import Path
from sanitize_runtime import sanitize_runtime

ROOT = Path(__file__).resolve().parents[1]


def build_platform():
    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64", "python/lib/python3.12/site-packages"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64", "python/Lib/site-packages"
    raise SystemExit(f"Unsupported build platform: {sys.platform} {platform.machine()}")


PLATFORM, SITE_PACKAGES = build_platform()
parser = argparse.ArgumentParser()
parser.add_argument("--python", choices=["bundled", "local"], default="bundled")
mode = parser.parse_args().python
version = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))["version"]
runtime = ROOT / f".cache/package/{PLATFORM}"
if not (runtime / "runtime.json").exists():
    raise SystemExit("Run .venv/bin/python scripts/stage_runtime.py first")
suffix = "-local-python" if mode == "local" else ""
output = ROOT / "dist" / f"paperbridge-{version}-{PLATFORM}{suffix}.xpi"
output.parent.mkdir(exist_ok=True)
payload = runtime.parent / f"runtime-payload-{mode}.zip"
if sanitize_runtime(runtime):
    # Both variants share the staged binaries; neither may reuse an unsanitized payload.
    for cached in runtime.parent.glob("runtime-payload*.zip"):
        cached.unlink()
if not payload.exists():
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(runtime.rglob("*")):
            if not path.is_file() or path.relative_to(runtime).parts[0] == "backend" or path.name == "runtime.json":
                continue
            # Bytecode caches appear in the staging tree whenever someone runs the staged
            # interpreter; they are never part of the shipped runtime.
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            relative = path.relative_to(runtime).as_posix()
            # Only the layout model and tokenizer vocabulary are runtime assets. Anything else
            # under .cache (extracted system fonts, paragraph caches) must never be redistributed:
            # developers who ran the engine from the staging directory leave it behind.
            if relative.startswith(".cache/") and not relative.startswith(
                    (".cache/babeldoc/models/", ".cache/babeldoc/tiktoken/")):
                continue
            if mode == "local" and relative.startswith("python/") and not relative.startswith(SITE_PACKAGES + "/"):
                continue
            info = zipfile.ZipInfo(f"runtime/{PLATFORM}/" + relative, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (path.stat().st_mode & 0o777) << 16
            with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as destination:
                shutil.copyfileobj(source, destination)
shutil.copyfile(payload, output)
with zipfile.ZipFile(output, "a", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.writestr("LICENSE",(ROOT / "LICENSE").read_text(encoding="utf-8"))
    metadata=json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
    metadata["version"]=version
    metadata["pythonMode"]=mode
    with payload.open("rb") as stream:
        metadata["payloadSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    identity = hashlib.sha256(json.dumps(metadata,sort_keys=True).encode())
    for path in sorted((ROOT / "backend").glob("*.py")):
        identity.update(path.read_bytes())
    metadata["buildId"] = identity.hexdigest()
    archive.writestr(f"runtime/{PLATFORM}/runtime.json",json.dumps(metadata,indent=2))
    for folder, prefix in [(ROOT / "addon", ""), (ROOT / "backend", f"runtime/{PLATFORM}/backend/")]:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                info = zipfile.ZipInfo(prefix + path.relative_to(folder).as_posix(), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
with output.open("rb") as stream:
    digest = hashlib.file_digest(stream,"sha256").hexdigest()
output.with_suffix(".xpi.sha256").write_text(f"{digest}  {output.name}\n")
print(f"{output} ({output.stat().st_size:,} bytes)")
