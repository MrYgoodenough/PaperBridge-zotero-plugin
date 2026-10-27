#!/bin/sh
# Build tools and sources stay in the project; installed plugins never download.
set -eu
cd "$(dirname "$0")/.."
task_root="$PWD"
task_src="$task_root/.cache/opencv-4.12.0"
task_build="$task_root/.cache/opencv-build"
task_install="$task_root/.cache/opencv-install"
if [ ! -d "$task_src" ]; then
  tar -xzf .cache/opencv-4.12.0.tar.gz -C .cache
fi
export PATH="$task_root/.venv/bin:$PATH"
cmake -S "$task_src" -B "$task_build" -G Ninja \
  -U 'PYTHON3*' \
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
  -DPYTHON3_EXECUTABLE="$task_root/.venv/bin/python" \
  -DPYTHON3_INCLUDE_DIR="$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_path("include"))')" \
  -DPYTHON3_LIBRARY="$(.venv/bin/python -c 'import sys; print(sys.base_prefix + "/lib/libpython3.12.dylib")')" \
  -DPYTHON3_PACKAGES_PATH="$task_install" \
  -DPYTHON3_NUMPY_INCLUDE_DIRS="$(.venv/bin/python -c 'import numpy; print(numpy.get_include())')"
cmake --build "$task_build" --parallel 4
cmake --install "$task_build"
cp "$task_src/LICENSE" "$task_install/cv2/LICENSE-OpenCV.txt"
mkdir -p "$task_install/cv2/licenses"
cp "$task_src/3rdparty/libjpeg-turbo/LICENSE.md" "$task_install/cv2/licenses/libjpeg-turbo.txt"
cp "$task_src/3rdparty/libpng/LICENSE" "$task_install/cv2/licenses/libpng.txt"
cp "$task_src/3rdparty/zlib/LICENSE" "$task_install/cv2/licenses/zlib.txt"
