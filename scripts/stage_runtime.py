"""Stage a relocatable macOS arm64 runtime, without a venv or host site-packages."""
import importlib.metadata
import json
import re
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from packaging.requirements import Requirement
from sanitize_runtime import sanitize_runtime

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / ".cache/package/macos-arm64"
# The pinned engine uses only line clustering and grayscale SSIM from these
# toolkits. compact_math supplies those operations; model-hub clients are unused.
OMIT = {"ruff", "scipy", "scikit-learn", "scikit-image", "huggingface-hub", "hf-xet",
        "networkx", "narwhals", "joblib", "threadpoolctl", "imageio", "tifffile", "lazy-loader",
        "opencv-python-headless"}


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=True)


def stage():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Build this runtime on macOS arm64.")
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True, exist_ok=True)
    base = Path(sys.base_prefix)
    copy(base / "bin/python3.12", STAGE / "python/bin/python3.12")
    shutil.copytree(base / "lib", STAGE / "python/lib", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests", "pkgconfig", "*.pyc",
                                                 "libpython*", "libtcl*", "tcl*", "tk*", "itcl*", "thread3*", "idlelib", "turtle*", "config-3.12*"))
    exported = subprocess.check_output([str(ROOT / ".tools/bin/uv"), "export", "--frozen", "--no-dev", "--no-hashes", "--no-emit-project"],
                                       cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
    requirements = [Requirement(line) for line in exported.splitlines() if re.match(r"^[\w.-]+==", line)]
    names = [requirement.name for requirement in requirements if requirement.marker is None or requirement.marker.evaluate()]
    destination = STAGE / "python/lib/python3.12/site-packages"
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
            source = Path(dist.locate_file(entry))
            if source.is_file():
                copy(source, destination / entry)
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
        source = path.read_text()
        assert source.count(old) == 1, name
        path.write_text(source.replace(old, new))
    shutil.copytree(ROOT / "backend", STAGE / "backend", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ["models", "tiktoken"]:
        shutil.copytree(ROOT / ".cache/babeldoc" / name, STAGE / ".cache/babeldoc" / name, dirs_exist_ok=True)
    version = json.loads((ROOT / "addon/manifest.json").read_text())["version"]
    (STAGE / "runtime.json").write_text(json.dumps({"version":version,"platform":"macos-arm64",
        "python":sys.version.split()[0],"packages":packages},indent=2))
    sanitize_runtime(STAGE)
    for path in STAGE.parent.glob("runtime-payload*.zip"):
        path.unlink()
    print(STAGE)


if __name__ == "__main__":
    stage()
