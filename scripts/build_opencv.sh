#!/bin/sh
# Build pinned image-only OpenCV on native macOS arm64; installed plugins never download.
set -eu
cd "$(dirname "$0")/.."

# Keep source and build outputs local, with the existing macOS paths as defaults.
task_root="$PWD"
task_work="${OPENCV_MACOS_WORK_DIR:-$task_root/.cache}"
# The original tagged archive is shared with the pinned Linux source build.
task_archive="${OPENCV_SOURCE_ARCHIVE:-$task_root/.cache/opencv-4.12.0.tar.gz}"
# Pin the verified official archive bytes, matching the existing Linux source baseline.
task_source_url="https://codeload.github.com/opencv/opencv/tar.gz/refs/tags/4.12.0"
task_source_sha256="44c106d5bb47efec04e531fd93008b3fcd1d27138985c5baf4eafac0e1ec9e9d"
# Re-extracted sources and native build/install outputs never replace a staged runtime.
task_src="$task_work/opencv-4.12.0"
task_build="$task_work/opencv-build"
task_install="$task_work/opencv-install"
# Project-local tools define the CPython extension ABI and avoid Homebrew tool drift.
task_python="$task_root/.venv/bin/python"
task_ninja="$task_root/.venv/bin/ninja"
# Four workers match the existing build default; small native builders may override it.
task_jobs="${OPENCV_JOBS:-4}"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) ;;
  *) printf 'This script builds only native macOS arm64 OpenCV.\n' >&2; exit 1 ;;
esac
# Ignore host Python and injected loader paths without modifying the project environment.
unset PYTHONHOME PYTHONPATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_INSERT_LIBRARIES
"$task_python" -I -B - <<'PY'
"""Reject an emulated or incompatible interpreter before touching build outputs."""
import platform
import sys
assert sys.platform == "darwin" and platform.machine() == "arm64"
assert sys.version_info[:2] == (3, 12)
PY
task_cmake=$("$task_python" -I -B -c 'from cmake import CMAKE_BIN_DIR; print(CMAKE_BIN_DIR + "/cmake")')
if [ ! -f "$task_archive" ]; then
  # Fetch only in this developer build, and never install an unchecked partial archive.
  mkdir -p "$(dirname "$task_archive")"
  curl -fL --retry 3 --connect-timeout 15 "$task_source_url" -o "$task_archive.tmp"
  task_verify="$task_archive.tmp"
else
  task_verify="$task_archive"
fi
"$task_python" -I -B - "$task_verify" "$task_source_sha256" <<'PY'
"""Verify the original archive even when a developer supplied it locally."""
import hashlib
from pathlib import Path
import sys
with Path(sys.argv[1]).open("rb") as stream:
    actual = hashlib.file_digest(stream, "sha256").hexdigest()
if actual != sys.argv[2]:
    raise SystemExit(f"OpenCV 4.12.0 source archive SHA-256 mismatch: {actual}")
PY
if [ "$task_verify" != "$task_archive" ]; then
  mv "$task_verify" "$task_archive"
fi
# Stale sources or flags must not be presented as a verified candidate build.
mkdir -p "$task_work"
rm -rf "$task_src" "$task_build" "$task_install"
tar -xzf "$task_archive" -C "$task_work"

# Preserve the existing macOS 13.0 deployment floor while building a thin arm64 extension.
"$task_cmake" -S "$task_src" -B "$task_build" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$task_ninja" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_INSTALL_PREFIX="$task_install" \
  -DBUILD_LIST=core,imgproc,imgcodecs,python3 -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF \
  -DBUILD_JAVA=OFF -DBUILD_DOCS=OFF -DBUILD_opencv_python2=OFF \
  -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_AVFOUNDATION=OFF -DWITH_1394=OFF \
  -DWITH_QT=OFF -DWITH_GTK=OFF -DWITH_OPENGL=OFF -DWITH_OPENCL=OFF \
  -DWITH_VTK=OFF -DWITH_ADE=OFF -DWITH_ITT=OFF -DWITH_PROTOBUF=OFF \
  -DWITH_OPENEXR=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF -DWITH_WEBP=OFF \
  -DWITH_AVIF=OFF -DWITH_TIFF=OFF -DWITH_OBSENSOR=OFF \
  -DWITH_IPP=OFF -DWITH_LAPACK=OFF -DWITH_CUDA=OFF \
  -DBUILD_ZLIB=ON -DBUILD_JPEG=ON -DBUILD_PNG=ON \
  -DPYTHON3_EXECUTABLE="$task_python" \
  -DPYTHON3_INCLUDE_DIR="$("$task_python" -I -B -c 'import sysconfig; print(sysconfig.get_path("include"))')" \
  -DPYTHON3_LIBRARY="$("$task_python" -I -B -c 'import sys, sysconfig; from pathlib import Path; print(Path(sys.base_prefix) / "lib" / sysconfig.get_config_var("LDLIBRARY"))')" \
  -DPYTHON3_PACKAGES_PATH="$task_install" \
  -DPYTHON3_NUMPY_INCLUDE_DIRS="$("$task_python" -I -B -c 'import numpy; print(numpy.get_include())')"
"$task_cmake" --build "$task_build" --parallel "$task_jobs"
"$task_cmake" --install "$task_build"
cp "$task_src/LICENSE" "$task_install/cv2/LICENSE-OpenCV.txt"
cp "$task_src/COPYRIGHT" "$task_install/cv2/COPYRIGHT-OpenCV.txt"
mkdir -p "$task_install/cv2/licenses"
cp "$task_src/3rdparty/libjpeg-turbo/LICENSE.md" "$task_install/cv2/licenses/libjpeg-turbo.txt"
cp "$task_src/3rdparty/libjpeg-turbo/README.ijg" "$task_install/cv2/licenses/README.ijg"
cp "$task_src/3rdparty/libpng/LICENSE" "$task_install/cv2/licenses/libpng.txt"
cp "$task_src/3rdparty/zlib/LICENSE" "$task_install/cv2/licenses/zlib.txt"
printf 'This software is based in part on the work of the Independent JPEG Group.\n' > "$task_install/cv2/NOTICE.txt"

"$task_python" -I -B - "$task_archive" "$task_build" "$task_install" "$task_src" "$task_source_url" <<'PY'
"""Record actual source, configuration and native extension evidence for source handoff."""
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import cmake
import numpy

archive, build, install, source = map(Path, sys.argv[1:5])
extensions = list((install / "cv2").rglob("cv2*.so"))
if len(extensions) != 1:
    raise SystemExit("The source build did not install exactly one cv2 extension")
architecture = subprocess.check_output(["lipo", "-archs", str(extensions[0])], text=True).strip()
if architecture != "arm64":
    raise SystemExit(f"OpenCV extension is not native arm64: {architecture}")
# Retain the embedded SoftFloat/fdlibm notices as well as the bundled codec licenses.
softfloat = (source / "modules/core/src/softfloat.cpp").read_text(encoding="utf-8")
(install / "cv2/licenses/softfloat-fdlibm.txt").write_text(softfloat.split("#include", 1)[0], encoding="utf-8")
sys.path.insert(0, str(install))
import cv2

information = cv2.getBuildInformation()
modules = re.search(r"To be built:\s+([^\n]+)", information).group(1).split()
if cv2.__version__ != "4.12.0" or sorted(modules) != ["core", "imgcodecs", "imgproc", "python3"]:
    raise SystemExit("Installed OpenCV does not match the pinned image-only scope")
cache = (build / "CMakeCache.txt").read_bytes()
# Read configured values so evidence cannot mistake requested flags for actual settings.
settings = dict(re.findall(r"^(\w+):[^=]+=(.*)$", cache.decode("utf-8"), re.M))
if settings.get("CMAKE_OSX_ARCHITECTURES") != "arm64" or settings.get("CMAKE_OSX_DEPLOYMENT_TARGET") != "13.0":
    raise SystemExit("OpenCV configuration does not match the native macOS deployment target")
shutil.copy2(build / "CMakeCache.txt", install / "CMakeCache.txt")
(install / "opencv-build-information.txt").write_text(information, encoding="utf-8")
with archive.open("rb") as stream:
    source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
provenance = {
    "version": cv2.__version__, "platform": "macos-arm64", "architecture": architecture,
    "modules": ["core", "imgproc", "imgcodecs", "python3"],
    "sourceArchiveUrl": sys.argv[5], "sourceArchiveSha256": source_hash,
    "sourceArchiveBytes": archive.stat().st_size, "python": platform.python_version(),
    "pythonAbi": sysconfig.get_config_var("SOABI"), "numpy": numpy.__version__,
    "cmake": cmake.__version__, "buildType": settings.get("CMAKE_BUILD_TYPE"),
    "deploymentTarget": settings["CMAKE_OSX_DEPLOYMENT_TARGET"], "buildMacOS": platform.mac_ver()[0],
    "extensionPath": extensions[0].relative_to(install).as_posix(),
    "extensionSha256": hashlib.sha256(extensions[0].read_bytes()).hexdigest(),
    "extensionBytes": extensions[0].stat().st_size,
    "cmakeCacheSha256": hashlib.sha256(cache).hexdigest(),
    "buildInformationSha256": hashlib.sha256((install / "opencv-build-information.txt").read_bytes()).hexdigest(),
}
(install / "opencv-build.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
print(install)
PY
