# Native Linux x64 GCC 10/glibc 2.31 sysroot; this build input is never shipped.
get_filename_component(PB_SYSROOT "${CMAKE_CURRENT_LIST_DIR}/debian11-sysroot" ABSOLUTE)
# Keep compilation and linking on the same older GNU ABI.
set(CMAKE_C_COMPILER "${PB_SYSROOT}/usr/bin/gcc-10")
set(CMAKE_CXX_COMPILER "${PB_SYSROOT}/usr/bin/g++-10")
set(CMAKE_SYSROOT "${PB_SYSROOT}")
# Execute the host's build tools, but resolve native headers/libraries in the sysroot.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
