"""Build a standalone XPI with a platform-specific Python engine and model."""
import hashlib
import argparse
import json
import shutil
import zipfile
from pathlib import Path
from sanitize_runtime import sanitize_runtime

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--python", choices=["bundled", "local"], default="bundled")
mode = parser.parse_args().python
version = json.loads((ROOT / "addon/manifest.json").read_text())["version"]
runtime = ROOT / ".cache/package/macos-arm64"
if not (runtime / "runtime.json").exists():
    raise SystemExit("Run .venv/bin/python scripts/stage_runtime.py first")
suffix = "-local-python" if mode == "local" else ""
output = ROOT / "dist" / f"paperbridge-{version}-macos-arm64{suffix}.xpi"
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
            relative = path.relative_to(runtime).as_posix()
            if mode == "local" and relative.startswith("python/") and not relative.startswith("python/lib/python3.12/site-packages/"):
                continue
            info = zipfile.ZipInfo("runtime/macos-arm64/" + path.relative_to(runtime).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (path.stat().st_mode & 0o777) << 16
            with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as destination:
                shutil.copyfileobj(source, destination)
shutil.copyfile(payload, output)
with zipfile.ZipFile(output, "a", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.writestr("LICENSE",(ROOT / "LICENSE").read_text())
    metadata=json.loads((runtime / "runtime.json").read_text())
    metadata["version"]=version
    metadata["pythonMode"]=mode
    with payload.open("rb") as stream:
        metadata["payloadSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    identity = hashlib.sha256(json.dumps(metadata,sort_keys=True).encode())
    for path in sorted((ROOT / "backend").glob("*.py")):
        identity.update(path.read_bytes())
    metadata["buildId"] = identity.hexdigest()
    archive.writestr("runtime/macos-arm64/runtime.json",json.dumps(metadata,indent=2))
    for folder, prefix in [(ROOT / "addon", ""), (ROOT / "backend", "runtime/macos-arm64/backend/")]:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                info = zipfile.ZipInfo(prefix + path.relative_to(folder).as_posix(), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
with output.open("rb") as stream:
    digest = hashlib.file_digest(stream,"sha256").hexdigest()
output.with_suffix(".xpi.sha256").write_text(f"{digest}  {output.name}\n")
print(f"{output} ({output.stat().st_size:,} bytes)")
