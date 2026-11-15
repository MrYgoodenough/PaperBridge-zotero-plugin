"""Stage a relocatable runtime for the build platform, without a venv or host site-packages."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path
from packaging.requirements import Requirement
from sanitize_runtime import sanitize_runtime

# Source tree and project-local staging locations.
ROOT = Path(__file__).resolve().parents[1]


def build_platform():
    """Return the native bundle name and Python paths."""
    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64", "python/bin/python3.12", "python/lib/python3.12/site-packages"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64", "python/python.exe", "python/Lib/site-packages"
    if sys.platform == "linux" and machine in {"amd64", "x86_64"}:
        return "linux-x64", "python/bin/python3.12", "python/lib/python3.12/site-packages"
    raise SystemExit(f"Unsupported build platform: {sys.platform} {platform.machine()}")


# Runtime paths match the platform key used by the addon launcher.
PLATFORM, PYTHON_EXECUTABLE, SITE_PACKAGES = build_platform()
# Each native build has its own relocatable staging tree.
STAGE = ROOT / f".cache/package/{PLATFORM}"
# The pinned engine uses only line clustering and grayscale SSIM from these
# toolkits. compact_math supplies those operations; model-hub clients are unused.
# Windows keeps the official wheel; Linux and macOS use image-only source builds.
OMIT = {"ruff", "scipy", "scikit-learn", "scikit-image", "huggingface-hub", "hf-xet",
        "networkx", "narwhals", "joblib", "threadpoolctl", "imageio", "tifffile", "lazy-loader"}
if sys.platform in {"darwin", "linux"}:
    OMIT.add("opencv-python-headless")
# Both source builds use the existing macOS version and module scope.
OPENCV_VERSION = "4.12.0"
OPENCV_MODULES = ["core", "imgproc", "imgcodecs", "python3"]


def copy(source, target):
    """Copy a file while preserving executable permissions."""
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=True)


def uv():
    """Find the project-local uv executable or an existing installation."""
    local = ROOT / ".tools/bin" / ("uv.exe" if os.name == "nt" else "uv")
    return str(local) if local.exists() else shutil.which("uv") or "uv"


def stage_interpreter():
    """Copy the base interpreter and its standard library into the bundle."""
    base = Path(sys.base_prefix)
    if sys.platform == "win32":
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
    # Drop development and GUI assets while keeping Linux ELF runtime libraries.
    ignored = ["site-packages", "__pycache__", "test", "tests", "pkgconfig", "*.pyc",
               "libtcl*", "tcl*", "tk*", "itcl*", "thread3*", "idlelib", "turtle*", "config-3.12*"]
    if sys.platform == "darwin":
        # The existing macOS executable does not need a bundled libpython dylib.
        ignored.append("libpython*")
    shutil.copytree(base / "lib", STAGE / "python/lib", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(*ignored))


def stage_packages(destination):
    """Copy locked runtime distributions, including wheel-owned native libraries."""
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
            # Keep wheel .libs directories beside their corresponding extension modules.
            source = Path(dist.locate_file(entry))
            if source.is_file():
                copy(source, destination / entry)
    return packages


def compact_opencv(install=None):
    """Locate the native image-only build before replacing any staged runtime."""
    if sys.platform not in {"darwin", "linux"}:
        return None
    default = ".cache/opencv-install" if sys.platform == "darwin" else ".cache/opencv-linux-x64/install"
    compact = Path(install) if install else ROOT / default
    script = "build_opencv.sh" if sys.platform == "darwin" else "build_opencv_linux.sh"
    if not (compact / "cv2").is_dir():
        raise SystemExit(f"Run scripts/{script} to build the image-only OpenCV module first")
    if sys.platform == "linux":
        provenance_path = compact / "opencv-build.json"
        if not provenance_path.is_file():
            raise SystemExit(f"Missing Linux OpenCV build provenance; rerun scripts/{script}")
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        extensions = list((compact / "cv2").rglob("cv2*.so"))
        if (provenance.get("platform") != PLATFORM or provenance.get("version") != OPENCV_VERSION
                or provenance.get("modules") != OPENCV_MODULES
                or provenance.get("pythonAbi") != sysconfig.get_config_var("SOABI")
                or len(extensions) != 1):
            raise SystemExit(f"Linux OpenCV build does not match this runtime; rerun scripts/{script}")
        if hashlib.sha256(extensions[0].read_bytes()).hexdigest() != provenance.get("extensionSha256"):
            raise SystemExit(f"Linux OpenCV extension changed since its build; rerun scripts/{script}")
    return compact


def stage_opencv(destination, compact):
    """Copy only the native image-only module and make its loader relocatable."""
    shutil.copytree(compact / "cv2", destination / "cv2", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (destination / "cv2/config.py").write_text("BINARIES_PATHS = []\n", encoding="utf-8")
    (destination / "cv2/config-3.12.py").write_text(
        "PYTHON_EXTENSIONS_PATHS = [os.path.join(LOADER_DIR, 'python-3.12')] + PYTHON_EXTENSIONS_PATHS\n",
        encoding="utf-8")
    package = {"name": "opencv-image-only", "version": OPENCV_VERSION, "modules": OPENCV_MODULES}
    if sys.platform == "linux":
        package["build"] = json.loads((compact / "opencv-build.json").read_text(encoding="utf-8"))
    return package


def stage(opencv_install=None):
    """Assemble the interpreter, backend, model and tokenizer runtime."""
    compact_cv = compact_opencv(opencv_install)
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True, exist_ok=True)
    stage_interpreter()
    destination = STAGE / SITE_PACKAGES
    packages = stage_packages(destination)
    if compact_cv:
        packages.append(stage_opencv(destination, compact_cv))
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
    for path in STAGE.parent.glob(f"runtime-payload-{PLATFORM}-*.zip"):
        path.unlink()
    print(STAGE)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-dir", type=Path, help="Use a separate candidate stage instead of the default platform tree")
    parser.add_argument("--opencv-install", type=Path, help="Use an existing native image-only OpenCV installation")
    options = parser.parse_args()
    if options.stage_dir:
        STAGE = options.stage_dir.resolve()
    stage(options.opencv_install)
