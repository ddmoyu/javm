cmake_minimum_required(VERSION 3.25)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" JAVM_PACKAGE_JSON)
string(JSON JAVM_APP_VERSION GET "${JAVM_PACKAGE_JSON}" version)
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" JAVM_CMAKE_VERSION "${JAVM_APP_VERSION}")

project(JAVM VERSION "${JAVM_CMAKE_VERSION}" LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 中文 MSVC 的 UTF-8 输出可能被 CMake 按 ANSI 误读，导致 Ninja 漏记头文件。
# 只修正本机实测的乱码前缀，其他语言继续使用 CMake 的检测结果。
if(MSVC AND CMAKE_GENERATOR MATCHES "Ninja" AND
   CMAKE_CXX_CL_SHOWINCLUDES_PREFIX MATCHES "^娉ㄦ剰: 鍖呭惈鏂囦欢:")
    set(CMAKE_CL_SHOWINCLUDES_PREFIX "注意: 包含文件: ")
endif()

add_subdirectory(native/database)
add_subdirectory(native/media)
add_subdirectory(native/http)
