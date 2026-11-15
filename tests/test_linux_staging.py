"""Check native OpenCV staging and fresh payloads without compiling test fixtures."""
import hashlib
import importlib.util
import json
import platform
import runpy
import shutil
import sys
import sysconfig
import zipfile
from pathlib import Path

import pytest

# Reuse the shipping scripts in small, isolated checkout trees.
ROOT = Path(__file__).resolve().parents[1]
# Linux and macOS share this CPython dependency layout.
SITE_PACKAGES = "python/lib/python3.12/site-packages"
# Initialize the real interpreter ABI before tests simulate another sys.platform.
INTERPRETER_ABI = sysconfig.get_config_var("SOABI")


def load_stager(monkeypatch, root, host="linux", machine="x86_64"):
    """Load staging policy for a simulated host without touching real runtime trees."""
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    monkeypatch.setattr(sys, "platform", host)
    monkeypatch.setattr(platform, "machine", lambda: machine)
    spec = importlib.util.spec_from_file_location("test_native_stager", ROOT / "scripts/stage_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = root
    module.STAGE = root / ".cache/package" / module.PLATFORM
    return module


def image_only_install(path, stager):
    """Create a tiny source-build fixture with a matching ABI and extension hash."""
    extension = path / "cv2/python-3.12/cv2.cpython-312-x86_64-linux-gnu.so"
    extension.parent.mkdir(parents=True)
    extension.write_bytes(b"\x7fELF native OpenCV fixture")
    (path / "cv2/config.py").write_text("BINARIES_PATHS = ['/old/build']\n")
    provenance = {
        "version": stager.OPENCV_VERSION, "platform": "linux-x64",
        "modules": stager.OPENCV_MODULES, "pythonAbi": INTERPRETER_ABI,
        "sourceArchiveSha256": "fixture-source",
        "extensionSha256": hashlib.sha256(extension.read_bytes()).hexdigest(),
    }
    (path / "opencv-build.json").write_text(json.dumps(provenance))
    return extension


def test_linux_interpreter_keeps_native_libraries(tmp_path, monkeypatch):
    """Keep libpython aliases and stdlib extensions while dropping existing UI/dev assets."""
    stager = load_stager(monkeypatch, tmp_path)
    base = tmp_path / "base"
    files = {
        "bin/python3.12": b"\x7fELF interpreter",
        "lib/libpython3.12.so.1.0": b"\x7fELF required libpython",
        "lib/python3.12/lib-dynload/_ssl.so": b"\x7fELF ssl",
        "lib/python3.12/encodings/__init__.py": b"# Encoding fixture.\n",
        "lib/python3.12/tkinter/__init__.py": b"# GUI fixture.\n",
        "lib/python3.12/test/test_fixture.py": b"# Test fixture.\n",
        "lib/python3.12/config-3.12-x86_64-linux-gnu/Makefile": b"development",
        "lib/pkgconfig/python.pc": b"development",
    }
    for relative, contents in files.items():
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    (base / "lib/libpython3.12.so").symlink_to("libpython3.12.so.1.0")
    monkeypatch.setattr(sys, "base_prefix", str(base))
    stager.stage_interpreter()
    for relative in ("bin/python3.12", "lib/libpython3.12.so.1.0", "lib/python3.12/lib-dynload/_ssl.so"):
        assert (stager.STAGE / "python" / relative).read_bytes() == files[relative]
    assert (stager.STAGE / "python/lib/libpython3.12.so").read_bytes() == files["lib/libpython3.12.so.1.0"]
    for relative in ("lib/python3.12/tkinter", "lib/python3.12/test", "lib/python3.12/config-3.12-x86_64-linux-gnu", "lib/pkgconfig"):
        assert not (stager.STAGE / "python" / relative).exists()


@pytest.mark.parametrize("host,machine,omit_wheel", [("linux", "x86_64", True), ("darwin", "arm64", True), ("win32", "AMD64", False)])
def test_native_opencv_policy(tmp_path, monkeypatch, host, machine, omit_wheel):
    """Use Linux/macOS source modules without changing Windows wheel or macOS build paths."""
    stager = load_stager(monkeypatch, tmp_path, host, machine)
    assert ("opencv-python-headless" in stager.OMIT) == omit_wheel
    if host == "win32":
        assert stager.compact_opencv() is None
        return
    relative = ".cache/opencv-install" if host == "darwin" else ".cache/opencv-linux-x64/install"
    install = tmp_path / relative
    extension = image_only_install(install, stager)
    if host == "darwin":
        # macOS retains its existing installation contract, without Linux provenance.
        (install / "opencv-build.json").unlink()
    assert stager.compact_opencv() == install
    destination = tmp_path / "candidate" / SITE_PACKAGES
    metadata = stager.stage_opencv(destination, install)
    assert metadata["modules"] == ["core", "imgproc", "imgcodecs", "python3"]
    assert (destination / extension.relative_to(install)).read_bytes() == extension.read_bytes()
    assert (destination / "cv2/config.py").read_text() == "BINARIES_PATHS = []\n"
    assert "os.path.join(LOADER_DIR, 'python-3.12')" in (destination / "cv2/config-3.12.py").read_text()


def test_missing_linux_build_preserves_stage(tmp_path, monkeypatch):
    """Reject a missing/changed source build before deleting the previous runtime."""
    stager = load_stager(monkeypatch, tmp_path)
    stager.STAGE.mkdir(parents=True)
    previous = stager.STAGE / "protected"
    previous.write_bytes(b"previous runtime")
    with pytest.raises(SystemExit, match="build_opencv_linux.sh"):
        stager.stage()
    install = tmp_path / ".cache/opencv-linux-x64/install"
    extension = image_only_install(install, stager)
    extension.write_bytes(b"changed extension")
    with pytest.raises(SystemExit, match="changed since its build"):
        stager.stage()
    assert previous.read_bytes() == b"previous runtime"


def test_candidate_stage_retains_resources_and_other_platforms(tmp_path, monkeypatch):
    """Stage a candidate independently, keeping models, tokenizer and unrelated payloads."""
    stager = load_stager(monkeypatch, tmp_path)
    old_stage = stager.STAGE
    old_stage.mkdir(parents=True)
    (old_stage / "protected").write_bytes(b"old runtime")
    stager.STAGE = tmp_path / "candidate/package/linux-x64"
    stager.STAGE.parent.mkdir(parents=True)
    windows_payload = stager.STAGE.parent / "runtime-payload-windows-x64-local.zip"
    windows_payload.write_bytes(b"Windows payload")
    linux_payload = stager.STAGE.parent / "runtime-payload-linux-x64-bundled.zip"
    linux_payload.write_bytes(b"stale Linux payload")
    install = tmp_path / ".cache/opencv-linux-x64/install"
    image_only_install(install, stager)
    for relative, contents in {
        "addon/manifest.json": b'{"version":"0.3.5"}',
        "backend/compact_math.py": b'"""Math fixture."""\n',
        ".cache/babeldoc/models/layout.onnx": b"original model",
        ".cache/babeldoc/tiktoken/vocabulary": b"original tokenizer",
    }.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)

    def packages(destination):
        """Supply the two pinned imports that staging intentionally redirects."""
        for relative, text in {
            "babeldoc/format/pdf/document_il/utils/extract_char.py": "from sklearn.cluster import DBSCAN\n",
            "babeldoc/format/pdf/document_il/midend/detect_scanned_file.py": "from skimage.metrics import structural_similarity\n",
        }.items():
            path = destination / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        return []

    monkeypatch.setattr(stager, "stage_interpreter", lambda: None)
    monkeypatch.setattr(stager, "stage_packages", packages)
    stager.stage(install)
    assert (old_stage / "protected").read_bytes() == b"old runtime"
    assert windows_payload.read_bytes() == b"Windows payload" and not linux_payload.exists()
    assert (stager.STAGE / ".cache/babeldoc/models/layout.onnx").read_bytes() == b"original model"
    assert (stager.STAGE / ".cache/babeldoc/tiktoken/vocabulary").read_bytes() == b"original tokenizer"
    metadata = json.loads((stager.STAGE / "runtime.json").read_text())
    assert metadata["packages"][-1]["build"]["sourceArchiveSha256"] == "fixture-source"
    assert "compact_math" in (stager.STAGE / SITE_PACKAGES / "babeldoc/format/pdf/document_il/utils/extract_char.py").read_text()


@pytest.mark.parametrize("mode", ["bundled", "local"])
def test_build_replaces_changed_payload_outside_dist(tmp_path, monkeypatch, mode):
    """Rebuild modified, added and deleted native files rather than blindly reusing a ZIP."""
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    script = tmp_path / "scripts/build.py"
    script.parent.mkdir()
    shutil.copy2(ROOT / "scripts/build.py", script)
    runtime = tmp_path / "candidate/package/linux-x64"
    files = {
        "addon/manifest.json": (ROOT / "addon/manifest.json").read_bytes(),
        "backend/server.py": b'"""Backend fixture."""\n',
        "LICENSE": b"License fixture\n",
        "dist/old.xpi": b"protected old XPI",
        "candidate/package/linux-x64/runtime.json": b'{"platform":"linux-x64","packages":[]}',
        "candidate/package/linux-x64/python/bin/python3.12": b"interpreter fixture",
        "candidate/package/linux-x64/python/lib/libpython3.12.so": b"libpython fixture",
        f"candidate/package/linux-x64/{SITE_PACKAGES}/cv2/module.so": b"old cv2",
        f"candidate/package/linux-x64/{SITE_PACKAGES}/old.libs/remove.so": b"unused wheel library",
        "candidate/package/linux-x64/.cache/babeldoc/models/layout.onnx": b"model fixture",
        "candidate/package/linux-x64/.cache/babeldoc/tiktoken/vocabulary": b"tokenizer fixture",
    }
    for relative, contents in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    output = tmp_path / "candidate/output"
    monkeypatch.setattr(sys, "argv", [str(script), "--platform", "linux-x64", "--python", mode,
                                     "--stage-dir", str(runtime), "--output-dir", str(output)])
    runpy.run_path(str(script), run_name="__main__")
    (runtime / SITE_PACKAGES / "cv2/module.so").write_bytes(b"new native image-only cv2")
    (runtime / SITE_PACKAGES / "old.libs/remove.so").unlink()
    (runtime / SITE_PACKAGES / "cv2/new.so").write_bytes(b"new library")
    runpy.run_path(str(script), run_name="__main__")
    with zipfile.ZipFile(next(output.glob("*.xpi"))) as archive:
        prefix = "runtime/linux-x64/"
        assert archive.read(prefix + SITE_PACKAGES + "/cv2/module.so") == b"new native image-only cv2"
        assert archive.read(prefix + SITE_PACKAGES + "/cv2/new.so") == b"new library"
        assert prefix + SITE_PACKAGES + "/old.libs/remove.so" not in archive.namelist()
        assert (prefix + "python/lib/libpython3.12.so" in archive.namelist()) == (mode == "bundled")
        assert archive.read(prefix + ".cache/babeldoc/tiktoken/vocabulary") == b"tokenizer fixture"
    assert (tmp_path / "dist/old.xpi").read_bytes() == b"protected old XPI"
