#!/bin/sh
# Build the same image-only OpenCV scope as macOS, using local Linux tools and sources.
set -eu
cd "$(dirname "$0")/.."

# Keep Linux outputs separate from the existing macOS source build.
task_root="$PWD"
task_work="${OPENCV_LINUX_WORK_DIR:-$task_root/.cache/opencv-linux-x64}"
task_archive="${OPENCV_SOURCE_ARCHIVE:-$task_root/.cache/opencv-4.12.0.tar.gz}"
task_src="$task_work/source/opencv-4.12.0"
task_build="$task_work/build"
task_install="$task_work/install"
# The project interpreter and pinned dev tools define the extension ABI.
task_python="$task_root/.venv/bin/python"
task_ninja="$task_root/.venv/bin/ninja"
# Four workers match the existing source-build default; builders can override it.
task_jobs="${OPENCV_JOBS:-4}"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) ;;
  *) printf 'This script builds only native Linux x64 OpenCV.\n' >&2; exit 1 ;;
esac
if [ ! -f "$task_archive" ]; then
  printf 'Provide the OpenCV 4.12.0 source archive via OPENCV_SOURCE_ARCHIVE; no downloads are performed.\n' >&2
  exit 1
fi
# Ignore inherited environment paths, but never alter the project's Python runtime.
unset PYTHONHOME PYTHONPATH LD_LIBRARY_PATH LD_PRELOAD
task_cmake=$("$task_python" -B -c 'from cmake import CMAKE_BIN_DIR; print(CMAKE_BIN_DIR + "/cmake")')
# A native older-glibc toolchain avoids raising the existing Linux runtime baseline.
set --
if [ -n "${OPENCV_TOOLCHAIN_FILE:-}" ]; then
  set -- "-DCMAKE_TOOLCHAIN_FILE=$OPENCV_TOOLCHAIN_FILE"
fi
mkdir -p "$task_work"
# Reconfigure from clean sources and outputs so changed flags cannot reuse an old payload.
rm -rf "$task_work/source" "$task_build" "$task_install"
mkdir -p "$task_work/source"
tar -xzf "$task_archive" -C "$task_work/source"

"$task_cmake" -S "$task_src" -B "$task_build" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$task_ninja" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_INSTALL_PREFIX="$task_install" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' \
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
  -DPYTHON3_INCLUDE_DIR="$("$task_python" -B -c 'import sysconfig; print(sysconfig.get_path("include"))')" \
  -DPYTHON3_LIBRARY="$("$task_python" -B -c 'import sys, sysconfig; from pathlib import Path; print(Path(sys.base_prefix) / "lib" / sysconfig.get_config_var("LDLIBRARY"))')" \
  -DPYTHON3_PACKAGES_PATH="$task_install" \
  -DPYTHON3_NUMPY_INCLUDE_DIRS="$("$task_python" -B -c 'import numpy; print(numpy.get_include())')" "$@"
"$task_cmake" --build "$task_build" --parallel "$task_jobs"
# Match the macOS install method; do not post-process CPython or other ELF libraries.
"$task_cmake" --install "$task_build"
cp "$task_src/LICENSE" "$task_install/cv2/LICENSE-OpenCV.txt"
cp "$task_src/COPYRIGHT" "$task_install/cv2/COPYRIGHT-OpenCV.txt"
mkdir -p "$task_install/cv2/licenses"
cp "$task_src/3rdparty/libjpeg-turbo/LICENSE.md" "$task_install/cv2/licenses/libjpeg-turbo.txt"
cp "$task_src/3rdparty/libjpeg-turbo/README.ijg" "$task_install/cv2/licenses/README.ijg"
cp "$task_src/3rdparty/libpng/LICENSE" "$task_install/cv2/licenses/libpng.txt"
cp "$task_src/3rdparty/zlib/LICENSE" "$task_install/cv2/licenses/zlib.txt"
printf 'This software is based in part on the work of the Independent JPEG Group.\n' > "$task_install/cv2/NOTICE.txt"

"$task_python" -B - "$task_archive" "$task_build" "$task_install" "$task_src" <<'PY'
"""Record source and tool provenance for the staged image-only extension."""
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import sysconfig
from pathlib import Path
import cmake
import numpy

# The image-only build must not raise the existing Linux glibc baseline.
MAX_GLIBC = (2, 34)

archive, build, install, source = map(Path, sys.argv[1:])
with archive.open("rb") as stream:
    source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
extensions = list((install / "cv2").rglob("cv2*.so"))
if len(extensions) != 1:
    raise SystemExit("The source build did not install exactly one cv2 extension")
# Preserve the licenses embedded in the core's bundled SoftFloat/fdlibm implementation.
softfloat = (source / "modules/core/src/softfloat.cpp").read_text(encoding="utf-8")
(install / "cv2/licenses/softfloat-fdlibm.txt").write_text(softfloat.split("#include", 1)[0], encoding="utf-8")
sys.path.insert(0, str(install))
import cv2

modules = re.search(r"To be built:\s+([^\n]+)", cv2.getBuildInformation()).group(1).split()
if cv2.__version__ != "4.12.0" or sorted(modules) != ["core", "imgcodecs", "imgproc", "python3"]:
    raise SystemExit("Installed OpenCV does not match the macOS image-only scope")
symbols = subprocess.check_output(["readelf", "--dyn-syms", "--wide", str(extensions[0])], text=True)
glibc_versions = re.findall(r"\bGLIBC_(\d+(?:\.\d+)+)", symbols)
minimum_glibc = max(glibc_versions, key=lambda version: tuple(map(int, version.split("."))))
provenance = {
    "version": cv2.__version__, "platform": "linux-x64",
    "modules": ["core", "imgproc", "imgcodecs", "python3"],
    "sourceArchiveSha256": source_hash, "python": platform.python_version(),
    "pythonAbi": sysconfig.get_config_var("SOABI"), "numpy": numpy.__version__,
    "cmake": cmake.__version__, "buildType": "MinSizeRel",
    "minimumGlibc": minimum_glibc,
    "extensionSha256": hashlib.sha256(extensions[0].read_bytes()).hexdigest(),
    "extensionBytes": extensions[0].stat().st_size,
    "cmakeCacheSha256": hashlib.sha256((build / "CMakeCache.txt").read_bytes()).hexdigest(),
}
toolchain = os.environ.get("OPENCV_TOOLCHAIN_FILE")
if toolchain:
    provenance["toolchainFileSha256"] = hashlib.sha256(Path(toolchain).read_bytes()).hexdigest()
(install / "opencv-build.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
if tuple(map(int, minimum_glibc.split("."))) > MAX_GLIBC:
    print(f"WARNING: this OpenCV needs glibc {minimum_glibc}; use an older native sysroot before releasing.", file=sys.stderr)
print(install)
PY
