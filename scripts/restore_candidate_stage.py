"""Restore a verified bundled XPI runtime for native candidate reuse, without executing it.

Native imports/inference and Zotero acceptance remain separate checks on the target OS.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import zipfile

# Match the existing build/staging platform names and bundled interpreter locations.
INTERPRETERS = {
    "linux-x64": "python/bin/python3.12",
    "windows-x64": "python/python.exe",
    "macos-arm64": "python/bin/python3.12",
}


def restore(xpi, output, platform, inventory=None):
    """Copy exact packaged runtime bytes/modes into a new stage, never an existing checkout."""
    with xpi.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if inventory:
        declared = json.loads(inventory.read_bytes())
        if declared["archive"]["sha256"] != source_hash:
            raise ValueError("Source XPI does not match its retained inventory")
    if output.exists():
        raise ValueError("Restore into a new stage; retain the earlier stage unchanged")

    prefix = f"runtime/{platform}/"
    with zipfile.ZipFile(xpi) as archive:
        runtime = json.loads(archive.read(prefix + "runtime.json"))
        if runtime["platform"] != platform or runtime["pythonMode"] != "bundled":
            raise ValueError("Native-stage reuse requires this platform's bundled XPI")
        members = [member for member in archive.infolist() if member.filename.startswith(prefix)
                   and not member.is_dir()]
        paths = {}
        for member in members:
            relative = PurePosixPath(member.filename[len(prefix):])
            if (not relative.parts or relative.is_absolute() or ".." in relative.parts
                    or "\\" in str(relative) or ":" in relative.parts[0]):
                raise ValueError("Unsafe packaged runtime path")
            paths[member.filename] = relative
        required = {"runtime.json", "backend/server.py", INTERPRETERS[platform]}
        if not required.issubset({str(path) for path in paths.values()}):
            raise ValueError("Bundled XPI is missing required runtime members")
        output.mkdir(parents=True)
        for member in members:
            target = output / paths[member.filename]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            # Preserve executable CPython launchers as well as ordinary file permissions.
            target.chmod((member.external_attr >> 16) & 0o777 or 0o644)

    return {"sourceXpi": str(xpi.resolve()), "sourceXpiSha256": source_hash,
            "stage": str(output.resolve()), "platform": platform, "python": runtime["python"],
            "runtimeMembers": len(members), "nativeCheckPerformed": False}


def main():
    """Restore a source-bound native stage and print its actual archive identity."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--platform", required=True, choices=tuple(INTERPRETERS))
    parser.add_argument("--inventory", type=Path, help="Retained actual XPI inventory for hash matching")
    options = parser.parse_args()
    print(json.dumps(restore(options.xpi, options.output, options.platform, options.inventory), indent=2))


if __name__ == "__main__":
    main()
