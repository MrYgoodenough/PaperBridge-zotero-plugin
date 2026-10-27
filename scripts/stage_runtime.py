"""Stage a relocatable runtime for the build platform, without a venv or host site-packages."""
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from packaging.requirements import Requirement
from sanitize_runtime import sanitize_runtime

ROOT = Path(__file__).resolve().parents[1]


def build_platform():
    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64", "python/bin/python3.12", "python/lib/python3.12/site-packages"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64", "python/python.exe", "python/Lib/site-packages"
    raise SystemExit(f"Unsupported build platform: {sys.platform} {platform.machine()}")


PLATFORM, PYTHON_EXECUTABLE, SITE_PACKAGES = build_platform()
STAGE = ROOT / f".cache/package/{PLATFORM}"
# The pinned engine uses only line clustering and grayscale SSIM from these
# toolkits. compact_math supplies those operations; model-hub clients are unused.
# Windows keeps the stock image module: the minimal OpenCV build script is macOS-only.
OMIT = {"ruff", "scipy", "scikit-learn", "scikit-image", "huggingface-hub", "hf-xet",
        "networkx", "narwhals", "joblib", "threadpoolctl", "imageio", "tifffile", "lazy-loader"}
if sys.platform != "win32":
    OMIT.add("opencv-python-headless")


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=True)


def uv():
    local = ROOT / ".tools/bin" / ("uv.exe" if os.name == "nt" else "uv")
    return str(local) if local.exists() else shutil.which("uv") or "uv"


def stage_interpreter():
    base = Path(sys.base_prefix)
    if os.name == "nt":
        python = STAGE / "python"
        python.mkdir(parents=True, exist_ok=True)
        for item in base.iterdir():
            if item.is_file() and item.suffix.lower() in {".exe", ".dll"}:
                copy(item, python / item.name)
        shutil.copytree(base / "DLLs", python / "DLLs", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pdb"))
        shutil.copytree(base / "Lib", python / "Lib", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests",
                                                      "idlelib", "tkinter", "turtledemo", "lib2to3",
                                                      "ensurepip", "pydoc_data", "*.pyc", "*.pdb"))
        return
    copy(base / "bin/python3.12", STAGE / "python/bin/python3.12")
    shutil.copytree(base / "lib", STAGE / "python/lib", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests", "pkgconfig", "*.pyc",
                                                 "libpython*", "libtcl*", "tcl*", "tk*", "itcl*", "thread3*", "idlelib", "turtle*", "config-3.12*"))


def stage_packages(destination):
    exported = subprocess.check_output([uv(), "export", "--frozen", "--no-dev", "--no-hashes", "--no-emit-project"],
                                       cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
    requirements = [Requirement(line) for line in exported.splitlines() if re.match(r"^[\w.-]+==", line)]
    names = [requirement.name for requirement in requirements if requirement.marker is None or requirement.marker.evaluate()]
    packages = []
    for name in names:
        if name.lower().replace("_", "-") in OMIT:
            continue
        dist = importlib.metadata.distribution(name)
        packages.append({"name": dist.metadata["Name"], "version": dist.version})
        for entry in dist.files or []:
            if ".." in entry.parts or any(part in {"tests", "test", "__pycache__"} for part in entry.parts):
                continue
            if entry.suffix in {".pyc", ".pxd", ".pyx", ".h", ".c", ".cpp"}:
                continue
            # The official wheel ships a ~29 MB ffmpeg shim for cv2.VideoCapture. Layout
            # translation never decodes video, and the macOS build has no videoio at all.
            if entry.name.startswith("opencv_videoio_ffmpeg") and entry.suffix in {".dll", ".dylib"}:
                continue
            source = Path(dist.locate_file(entry))
            if source.is_file():
                copy(source, destination / entry)
    return packages


def stage():
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True, exist_ok=True)
    stage_interpreter()
    destination = STAGE / SITE_PACKAGES
    packages = stage_packages(destination)
    if sys.platform != "win32":
        compact_cv = ROOT / ".cache/opencv-install"
        if not (compact_cv / "cv2").exists():
            raise SystemExit("Run scripts/build_opencv.sh to build the image-only OpenCV module first")
        shutil.copytree(compact_cv / "cv2", destination / "cv2", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (destination / "cv2/config.py").write_text("BINARIES_PATHS = []\n")
        (destination / "cv2/config-3.12.py").write_text(
            "PYTHON_EXTENSIONS_PATHS = [os.path.join(LOADER_DIR, 'python-3.12')] + PYTHON_EXTENSIONS_PATHS\n")
        packages.append({"name":"opencv-image-only", "version":"4.12.0", "modules":["core","imgproc","imgcodecs","python3"]})
    replacements = {
        "babeldoc/format/pdf/document_il/utils/extract_char.py": (
            "from sklearn.cluster import DBSCAN", "from compact_math import LineClusters as DBSCAN"),
        "babeldoc/format/pdf/document_il/midend/detect_scanned_file.py": (
            "from skimage.metrics import structural_similarity", "from compact_math import structural_similarity"),
    }
    for name, (old, new) in replacements.items():
        path = destination / name
        source = path.read_text(encoding="utf-8")
        assert source.count(old) == 1, name
        path.write_text(source.replace(old, new), encoding="utf-8")
    shutil.copytree(ROOT / "backend", STAGE / "backend", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ["models", "tiktoken"]:
        shutil.copytree(ROOT / ".cache/babeldoc" / name, STAGE / ".cache/babeldoc" / name, dirs_exist_ok=True)
    # Running the engine from the staging directory writes a font cache and paragraph cache
    # there; keep the staged tree limited to the assets the XPI is allowed to ship.
    for stale in (STAGE / ".cache").iterdir():
        if stale.name != "babeldoc":
            shutil.rmtree(stale) if stale.is_dir() else stale.unlink()
    for stale in (STAGE / ".cache/babeldoc").iterdir():
        if stale.name not in {"models", "tiktoken"}:
            shutil.rmtree(stale) if stale.is_dir() else stale.unlink()
    # A staged interpreter that was ever run leaves bytecode caches behind; drop them so the
    # XPI carries sources only (and so the staged tree matches what ships).
    for cache in list(STAGE.rglob("__pycache__")):
        shutil.rmtree(cache, ignore_errors=True)
    for bytecode in list(STAGE.rglob("*.pyc")):
        bytecode.unlink(missing_ok=True)
    version = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))["version"]
    (STAGE / "runtime.json").write_text(json.dumps({"version":version,"platform":PLATFORM,
        "python":sys.version.split()[0],"packages":packages},indent=2), encoding="utf-8")
    sanitize_runtime(STAGE)
    for path in STAGE.parent.glob("runtime-payload*.zip"):
        path.unlink()
    print(STAGE)


if __name__ == "__main__":
    stage()
