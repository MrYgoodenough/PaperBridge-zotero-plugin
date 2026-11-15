"""Check offline notice ownership and exact-byte supplemental provenance."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

import pytest

# Import the standalone inventory script without running a build.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from package_inventory import collect_inventory

# Synthetic Linux wheel paths exercise RECORD ownership, not a real license grant.
SITE = "python/lib/python3.12/site-packages/"


def _xpi(tmp_path, files, *, platform="linux-x64", python="3.12.16", packages=()):
    """Write a tiny completed archive without executing any shipped files."""
    path = tmp_path / "evidence.xpi"
    prefix = f"runtime/{platform}/"
    metadata = {"platform": platform, "python": python, "pythonMode": "bundled", "packages": list(packages)}
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(prefix + "runtime.json", json.dumps(metadata))
        archive.writestr("LICENSE", b"Synthetic project notice.\n")
        for name, contents in files.items():
            archive.writestr(name if name.startswith("licenses/") else prefix + name, contents)
    return collect_inventory(path)


@pytest.mark.parametrize("platform,python,stdlib", [
    ("linux-x64", "3.12.16", "python/lib/python3.12/LICENSE.txt"),
    ("windows-x64", "3.12.13", "python/Lib/LICENSE.txt"),
])
def test_stdlib_notices_do_not_borrow_dependency_licenses(tmp_path, platform, python, stdlib):
    """Keep Python evidence scoped to its own root and actual stdlib notice."""
    inventory = _xpi(tmp_path, {stdlib: b"Synthetic Python notice.\n",
                               SITE + "neighbour/LICENSE.txt": b"Unrelated notice.\n"},
                     platform=platform, python=python, packages=[{"name": "absent", "version": "1"}])
    component = next(item for item in inventory["components"] if item["name"] == "CPython interpreter/stdlib")
    assert [item["path"] for item in component["license"]["files"]] == [f"runtime/{platform}/" + stdlib]
    assert inventory["dependencies"][0]["license"]["status"] == "unknown"
    assert inventory["licenseCompliance"] == "unknown"


def test_record_owns_notices_and_native_hashes(tmp_path):
    """Use METADATA/RECORD evidence rather than a neighbouring module's notice."""
    dist = SITE + "widget-1.dist-info/"
    inventory = _xpi(tmp_path, {
        dist + "METADATA": b"Name: widget\nVersion: 1\nLicense-File: absent.txt\n\n",
        dist + "WHEEL": b"Wheel-Version: 1.0\nTag: cp312-cp312-manylinux_2_34_x86_64\n\n",
        dist + "RECORD": b"widget/NOTICE.txt,,\nwidget/native.so,,\n../outside/LICENSE.txt,,\n",
        SITE + "widget/NOTICE.txt": b"Owned notice.\n",
        SITE + "widget/native.so": b"Synthetic native bytes",
        SITE + "neighbour/LICENSE.txt": b"Unrelated notice.\n",
    }, packages=[{"name": "widget", "version": "1"}])
    package = inventory["dependencies"][0]
    assert package["license"]["missingDeclaredFiles"] == ["absent.txt"]
    assert [item["path"] for item in package["license"]["files"]] == ["runtime/linux-x64/" + SITE + "widget/NOTICE.txt"]
    assert package["nativeFiles"][0]["sha256"] == hashlib.sha256(b"Synthetic native bytes").hexdigest()
    assert package["wheel"]["tags"] == ["cp312-cp312-manylinux_2_34_x86_64"]
    assert package["metadataSha256"] and package["record"]["sha256"]


@pytest.mark.parametrize("change,expected", [
    ("none", "matched"), ("artifact", "unknown"), ("notice", "unknown"),
    ("empty_notice", "unknown"), ("missing_notice", "unknown"), ("version", "not_applicable"),
])
def test_supplemental_evidence_requires_matching_bytes_and_version(tmp_path, change, expected):
    """Never associate Linux/other-version or stale notice evidence with Windows 3.12.13."""
    entry = {"id": "synthetic-python", "component": "CPython interpreter/stdlib",
             "platform": "windows-x64", "python": "3.12.13",
             "artifacts": {"python/python.exe": hashlib.sha256(b"Interpreter").hexdigest()},
             "files": {"licenses/Python.txt": hashlib.sha256(b"Notice").hexdigest()},
             "limitations": ["Synthetic unresolved source obligation."]}
    files = {"python/python.exe": b"Interpreter", "licenses/Python.txt": b"Notice"}
    if change == "artifact":
        files["python/python.exe"] = b"Changed interpreter"
    elif change in {"notice", "empty_notice"}:
        files["licenses/Python.txt"] = b"Changed notice" if change == "notice" else b""
    elif change == "missing_notice":
        del files["licenses/Python.txt"]
    elif change == "version":
        entry["python"] = "3.12.14"
    files["licenses/provenance.json"] = json.dumps({"schemaVersion": 1, "entries": [entry]})
    inventory = _xpi(tmp_path, files, platform="windows-x64", python="3.12.13")
    assert inventory["licenseProvenance"]["entries"][0]["status"] == expected
    component = next(item for item in inventory["components"] if item["name"] == "CPython interpreter/stdlib")
    assert bool(component["license"]["files"]) == (expected == "matched")
    assert inventory["licenseCompliance"] == "unknown"
    if expected == "matched":
        assert any("Synthetic unresolved source obligation" in warning for warning in inventory["warnings"])
    elif expected == "unknown":
        assert any("provenance unknown" in warning for warning in inventory["warnings"])


@pytest.mark.parametrize("data", [b"not JSON", b"[]", b'{"schemaVersion":1,"entries":[null]}'])
def test_malformed_provenance_is_advisory(tmp_path, data):
    """Bad supplemental data must report unknown evidence, not stop runtime packaging."""
    inventory = _xpi(tmp_path, {"licenses/provenance.json": data})
    assert inventory["licenseProvenance"]["status"] == "unknown"
    assert any("invalid manifest" in warning for warning in inventory["warnings"])


@pytest.mark.parametrize("matched", [True, False])
def test_source_build_uses_only_matching_extension_notices(tmp_path, matched):
    """A compact OpenCV build needs native build evidence, not old wheel metadata."""
    extension = b"Synthetic source-built extension"
    digest = hashlib.sha256(extension).hexdigest() if matched else "0" * 64
    package = {"name": "opencv-image-only", "version": "4.12.0", "build": {
        "version": "4.12.0", "platform": "linux-x64", "extensionSha256": digest,
        "extensionBytes": len(extension)}}
    inventory = _xpi(tmp_path, {SITE + "cv2/cv2.abi3.so": extension,
                               SITE + "cv2/LICENSE": b"Synthetic OpenCV notice.\n",
                               SITE + "neighbour/LICENSE": b"Unrelated notice.\n"}, packages=[package])
    observed = inventory["dependencies"][0]
    assert observed["versionSource"] == ("runtime_manifest_native_build" if matched else "unknown")
    assert [item["path"] for item in observed["license"]["files"]] == (
        ["runtime/linux-x64/" + SITE + "cv2/LICENSE"] if matched else [])


def test_checked_in_provenance_hashes_actual_bundled_notices():
    """Keep recorded supplemental hashes tied to nonempty checked-in license files."""
    manifest = json.loads((ROOT / "addon/licenses/provenance.json").read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == 1 and manifest["entries"]
    for entry in manifest["entries"]:
        assert entry["artifacts"] and entry["files"] and entry["sources"]
        for name, digest in entry["files"].items():
            path = ROOT / "addon" / name if name.startswith("licenses/") else ROOT / name
            contents = path.read_bytes()
            assert contents and hashlib.sha256(contents).hexdigest() == digest, name
