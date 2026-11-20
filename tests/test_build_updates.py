"""Check update feeds with tiny staged runtimes, without building native dependencies."""
import hashlib
import json
import platform
import runpy
import sys
import tomllib
import zipfile
import zlib
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
        "scripts/package_inventory.py": (ROOT / "scripts/package_inventory.py").read_bytes(),
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
            prefix + f"{site_packages}/native/runtime.json": b'{"dependency": true}\n',
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
                assert archive.read(prefix + f"{site_packages}/native/runtime.json") == b'{"dependency": true}\n'
                assert archive.read(prefix + ".cache/babeldoc/models/layout.onnx") == b"model fixture"
                metadata = json.loads(archive.read(prefix + "runtime.json"))
                assert (metadata["version"], metadata["platform"], metadata["pythonMode"]) == (version, name, mode)
    assert {path.name for path in (build_tree / "dist/updates").iterdir()} == expected_feeds
    assert {path.name for path in (build_tree / "dist").glob("*.xpi")} == expected_xpis
    assert (build_tree / "addon/manifest.json").read_bytes() == source_bytes
    assert [path.name for path in (build_tree / "updates").iterdir()] == ["published.json"]
    assert (build_tree / "updates/published.json").read_bytes() == published_bytes


@pytest.mark.parametrize("host,machine", (("linux", "x86_64"), ("win32", "AMD64")))
def test_build_preserves_notice_bytes_and_is_reproducible(build_tree, monkeypatch, host, machine):
    """Keep notices unchanged, use requested compression and reproduce bytes at another time."""
    script = build_tree / "scripts/build.py"
    (build_tree / "LICENSE").write_bytes(b"Synthetic original license.\r\n")
    (build_tree / "NOTICE.md").write_bytes(b"Synthetic original notice.\r\n")
    _, _, target, _, site_packages = next(row for row in PLATFORMS if row[0] == host)
    # Repeated records distinguish configured level 9 from Python's default level 6.
    contents = b"".join(f"entry-{i % 97}: {i % 31} synthetic runtime metadata\n".encode() for i in range(5000))
    native = f"{site_packages}/native/module.bin"
    (build_tree / ".cache/package" / target / native).write_bytes(contents)
    monkeypatch.setattr(sys, "platform", host)
    monkeypatch.setattr(platform, "machine", Mock(return_value=machine))
    monkeypatch.setattr(sys, "argv", [str(script)])
    snapshots = []
    for timestamp in ((2026, 1, 2, 3, 4, 6, 4, 2, -1), (2027, 2, 3, 4, 5, 8, 2, 34, -1)):
        monkeypatch.setattr(zipfile.time, "localtime", Mock(return_value=timestamp))
        runpy.run_path(str(script), run_name="__main__")
        snapshots.append({p.relative_to(build_tree / "dist").as_posix(): p.read_bytes()
                          for p in (build_tree / "dist").rglob("*") if p.is_file()})
    assert snapshots[0] == snapshots[1]
    xpi = next((build_tree / "dist").glob("*.xpi"))
    with zipfile.ZipFile(xpi) as archive:
        assert archive.read("LICENSE") == (build_tree / "LICENSE").read_bytes()
        assert archive.read("NOTICE.md") == (build_tree / "NOTICE.md").read_bytes()
        assert len({entry.date_time for entry in archive.infolist()}) == 1
        # ZIP members use raw DEFLATE, with no zlib wrapper bytes.
        compressor = zlib.compressobj(9, wbits=-zlib.MAX_WBITS)
        compressed = compressor.compress(contents) + compressor.flush()
        assert archive.getinfo(f"runtime/{target}/{native}").compress_size == len(compressed)


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


def test_build_size_baseline_is_advisory_only(build_tree, monkeypatch):
    """Report like-for-like growth and unknown baselines without rejecting tiny packages."""
    script = build_tree / "scripts/build.py"
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(sys, "argv", [str(script)])
    runpy.run_path(str(script), run_name="__main__")
    xpi = next((build_tree / "dist").glob("*.xpi"))
    inventory_path = xpi.with_suffix(".xpi.inventory.json")
    baseline = build_tree / "previous.inventory.json"
    baseline.write_bytes(inventory_path.read_bytes())
    previous = json.loads(baseline.read_bytes())
    (build_tree / "addon/bootstrap.js").write_bytes(b"// Growing synthetic addon.\n" * 100)
    monkeypatch.setattr(sys, "argv", [str(script), "--previous-inventory", str(baseline)])
    runpy.run_path(str(script), run_name="__main__")
    current = json.loads(inventory_path.read_bytes())
    assert current["sizeTrend"]["status"] == "compared"
    for field in ("bytes", "expandedBytes"):
        trend = current["sizeTrend"]["sizes"][field]
        assert trend["previous"] == previous["archive"][field]
        assert trend["current"] == current["archive"][field] and trend["delta"] > 0
    assert any("advisory only, no size gate" in warning for warning in current["warnings"])
    previous["runtime"]["platform"] = "windows-x64"
    baseline.write_text(json.dumps(previous), encoding="utf-8")
    runpy.run_path(str(script), run_name="__main__")
    assert json.loads(inventory_path.read_bytes())["sizeTrend"]["status"] == "unknown"
    baseline.unlink()
    runpy.run_path(str(script), run_name="__main__")
    assert json.loads(inventory_path.read_bytes())["sizeTrend"]["status"] == "unknown" and xpi.is_file()


def test_repack_refreshes_source_built_extension_size(build_tree, monkeypatch):
    """Keep final hash/size evidence valid when a restored Mac extension already has its signed hash."""
    stage = build_tree / ".cache/package/macos-arm64"
    relative = "python/lib/python3.12/site-packages/cv2/python-3.12/cv2.test.so"
    extension = stage / relative
    extension.parent.mkdir(parents=True)
    extension.write_bytes(b"Synthetic relocated native extension")
    digest = hashlib.sha256(extension.read_bytes()).hexdigest()
    size = extension.stat().st_size
    metadata = json.loads((stage / "runtime.json").read_bytes())
    metadata["packages"] = [{"name": "opencv-image-only", "version": "4.12.0", "build": {
        "platform": "macos-arm64", "version": "4.12.0", "extensionSha256": digest,
        "extensionBytes": size + 1}}]
    (stage / "runtime.json").write_text(json.dumps(metadata), encoding="utf-8")
    script = build_tree / "scripts/build.py"
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(platform, "machine", Mock(return_value="arm64"))
    monkeypatch.setattr(sys, "argv", [str(script), "--python", "bundled"])
    runpy.run_path(str(script), run_name="__main__")
    version = json.loads((build_tree / "addon/manifest.json").read_bytes())["version"]
    xpi = build_tree / f"dist/paperbridge-{version}-macos-arm64.xpi"
    with zipfile.ZipFile(xpi) as archive:
        build = json.loads(archive.read("runtime/macos-arm64/runtime.json"))["packages"][0]["build"]
        assert build["extensionSha256"] == digest and build["extensionBytes"] == size
        assert build["unsanitizedExtensionBytes"] == size + 1
    inventory = json.loads(xpi.with_suffix(".xpi.inventory.json").read_bytes())
    assert any(dependency["name"] == "opencv-image-only" and dependency["version"] == "4.12.0"
               for dependency in inventory["dependencies"])


def test_source_package_versions_agree():
    """Keep the addon, project metadata and own lock entry on the same source version."""
    manifest = json.loads((ROOT / "addon/manifest.json").read_bytes())
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    own_versions = [package["version"] for package in lock["package"] if package["name"] == project["name"]]
    assert own_versions == [project["version"]] == [manifest["version"]]
