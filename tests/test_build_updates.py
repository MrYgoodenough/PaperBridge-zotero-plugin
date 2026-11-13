"""Check update feeds with tiny staged runtimes, without building native dependencies."""
import hashlib
import json
import platform
import runpy
import sys
import tomllib
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest

# Source files are copied into a temporary checkout before executing the build script.
ROOT = Path(__file__).resolve().parents[1]
# Supported hosts and their native interpreter/site-packages layouts.
PLATFORMS = (
    ("darwin", "arm64", "macos-arm64", "python/bin/python3.12", "python/lib/python3.12/site-packages"),
    ("win32", "AMD64", "windows-x64", "python/python.exe", "python/Lib/site-packages"),
    ("linux", "x86_64", "linux-x64", "python/bin/python3.12", "python/lib/python3.12/site-packages"),
)
# Public release and feed location expected by installed addons.
REPOSITORY = "MrYgoodenough/PaperBridge-zotero-plugin"


@pytest.fixture
def build_tree(tmp_path, monkeypatch):
    """Stage tiny files for all hosts in one checkout to expose cache/feed collisions."""
    files = {
        "scripts/build.py": (ROOT / "scripts/build.py").read_bytes(),
        "addon/manifest.json": (ROOT / "addon/manifest.json").read_bytes(),
        "addon/bootstrap.js": b"// Addon fixture.\n",
        "addon/assets/manifest.json": b'{"fixture": "not the addon manifest"}\n',
        "backend/server.py": b'"""Backend fixture."""\n',
        "LICENSE": b"Fixture license\n",
        "updates/published.json": b'{"fixture": "already published; do not change"}\n',
    }
    for _, _, name, interpreter, site_packages in PLATFORMS:
        prefix = f".cache/package/{name}/"
        files.update({
            prefix + "runtime.json": json.dumps({
                "version": "0.0.0", "platform": name, "python": "3.12.0", "packages": []
            }).encode(),
            prefix + interpreter: f"{name} interpreter".encode(),
            prefix + f"{site_packages}/native/module.bin": name.encode(),
            prefix + f"{site_packages}/native.libs/library.bin": name.encode(),
            prefix + ".cache/babeldoc/models/layout.onnx": b"model fixture",
        })
    for relative, contents in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    # Reuse the real sanitizer on tiny files; it never sees the actual staged runtime.
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    return tmp_path


def test_build_feeds_match_platform_and_python_mode(build_tree, monkeypatch):
    """Match all six feeds to exact XPIs while preserving source and published metadata."""
    script = build_tree / "scripts/build.py"
    source_bytes = (build_tree / "addon/manifest.json").read_bytes()
    manifest = json.loads(source_bytes)
    zotero = manifest["applications"]["zotero"]
    version = manifest["version"]
    published_bytes = (build_tree / "updates/published.json").read_bytes()
    expected_feeds = set()
    expected_xpis = set()
    for host, machine, name, interpreter, site_packages in PLATFORMS:
        for mode in ("bundled", "local"):
            with monkeypatch.context() as native:
                native.setattr(sys, "platform", host)
                native.setattr(platform, "machine", Mock(return_value=machine))
                native.setattr(sys, "argv", [str(script), "--python", mode])
                runpy.run_path(str(script), run_name="__main__")
            suffix = "-local-python" if mode == "local" else ""
            feed_name = f"{name}{suffix}.json"
            xpi_name = f"paperbridge-{version}-{name}{suffix}.xpi"
            expected_feeds.add(feed_name)
            expected_xpis.add(xpi_name)
            xpi = build_tree / "dist" / xpi_name
            digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
            assert xpi.with_suffix(".xpi.sha256").read_text() == f"{digest}  {xpi_name}\n"
            feed = json.loads((build_tree / "dist/updates" / feed_name).read_bytes())
            assert feed == {"addons": {zotero["id"]: {"updates": [{
                "version": version,
                "update_link": f"https://github.com/{REPOSITORY}/releases/download/v{version}/{xpi_name}",
                "update_hash": f"sha256:{digest}",
                "applications": {"zotero": {
                    key: zotero[key] for key in ("strict_min_version", "strict_max_version")
                }},
            }]}}}
            with zipfile.ZipFile(xpi) as archive:
                names = archive.namelist()
                assert names.count("manifest.json") == 1
                built_manifest = json.loads(archive.read("manifest.json"))
                assert built_manifest["applications"]["zotero"]["update_url"] == (
                    f"https://raw.githubusercontent.com/{REPOSITORY}/master/updates/{feed_name}"
                )
                built_manifest["applications"]["zotero"]["update_url"] = zotero["update_url"]
                assert built_manifest == manifest
                for path in (build_tree / "addon").rglob("*"):
                    if path.is_file() and path != build_tree / "addon/manifest.json":
                        assert archive.read(path.relative_to(build_tree / "addon").as_posix()) == path.read_bytes()
                prefix = f"runtime/{name}/"
                assert all(path.startswith(prefix) for path in names if path.startswith("runtime/"))
                assert (prefix + interpreter in names) == (mode == "bundled")
                assert archive.read(prefix + f"{site_packages}/native/module.bin") == name.encode()
                assert archive.read(prefix + f"{site_packages}/native.libs/library.bin") == name.encode()
                assert archive.read(prefix + ".cache/babeldoc/models/layout.onnx") == b"model fixture"
                metadata = json.loads(archive.read(prefix + "runtime.json"))
                assert (metadata["version"], metadata["platform"], metadata["pythonMode"]) == (version, name, mode)
    assert {path.name for path in (build_tree / "dist/updates").iterdir()} == expected_feeds
    assert {path.name for path in (build_tree / "dist").glob("*.xpi")} == expected_xpis
    assert (build_tree / "addon/manifest.json").read_bytes() == source_bytes
    assert [path.name for path in (build_tree / "updates").iterdir()] == ["published.json"]
    assert (build_tree / "updates/published.json").read_bytes() == published_bytes


def test_explicit_repackage_uses_the_staged_platform(build_tree, monkeypatch):
    """A Linux packager must not put Linux paths or metadata in a Windows draft."""
    script = build_tree / "scripts/build.py"
    metadata_path = build_tree / ".cache/package/windows-x64/runtime.json"
    staged_metadata = json.loads(metadata_path.read_bytes())
    staged_metadata["buildId"] = "inherited-old-build"
    metadata_path.write_text(json.dumps(staged_metadata))
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(sys, "argv", [str(script), "--platform", "windows-x64", "--python", "local"])
    runpy.run_path(str(script), run_name="__main__")
    xpi = next((build_tree / "dist").glob("*.xpi"))
    with zipfile.ZipFile(xpi) as archive:
        prefix = "runtime/windows-x64/"
        assert archive.read(prefix + "python/Lib/site-packages/native/module.bin") == b"windows-x64"
        assert not any(name.startswith("runtime/linux-x64/") for name in archive.namelist())
        metadata = json.loads(archive.read(prefix + "runtime.json"))
        build_id = metadata.pop("buildId")
        identity = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode())
        for path in sorted((build_tree / "backend").glob("*.py")):
            identity.update(path.read_bytes())
        assert metadata["platform"] == "windows-x64" and build_id == identity.hexdigest()
    metadata_path.write_text('{"platform":"linux-x64"}')
    with pytest.raises(SystemExit, match="metadata does not match"):
        runpy.run_path(str(script), run_name="__main__")


def test_source_package_versions_agree():
    """Keep the addon, project metadata and own lock entry on the same source version."""
    manifest = json.loads((ROOT / "addon/manifest.json").read_bytes())
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    own_versions = [package["version"] for package in lock["package"] if package["name"] == project["name"]]
    assert own_versions == [project["version"]] == [manifest["version"]]
