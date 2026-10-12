cmake_minimum_required(VERSION 3.25)
project(JavmDependencies LANGUAGES C CXX)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "Dependency bundles target Windows x64.")
endif()
get_filename_component(JAVM_PROJECT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
add_subdirectory("${JAVM_PROJECT_ROOT}/native/media/mediainfo" mediainfo)
add_custom_target(dependency_receipt ALL
    COMMAND ${CMAKE_COMMAND}
        "-DBINARY=$<TARGET_FILE:mediainfo>"
        "-DDEPENDENCIES=${JAVM_PROJECT_ROOT}/scripts/offline-dependencies.json"
        "-DOUTPUT=${CMAKE_BINARY_DIR}/bin/mediainfo-lite.json"
        "-DBUILD_TYPE=Release"
        "-DCOMPILER=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
        -P "${JAVM_PROJECT_ROOT}/native/media/mediainfo/write-receipt.cmake"
    DEPENDS mediainfo)
