# Keep upstream options scoped to this directory, away from the application.
include(FetchContent)
if(NOT JAVM_REPOSITORY_ROOT)
    set(JAVM_REPOSITORY_ROOT "${PROJECT_SOURCE_DIR}")
endif()
file(READ "${JAVM_REPOSITORY_ROOT}/scripts/offline-dependencies.json" dependencies)
string(JSON profile GET "${dependencies}" mediainfo)
string(JSON source_url GET "${profile}" url)
string(JSON source_hash GET "${profile}" sha256)
string(JSON source_file GET "${profile}" file)
if(EXISTS "${JAVM_REPOSITORY_ROOT}/.tmp/offline-dependencies/${source_file}")
    set(source_url "${JAVM_REPOSITORY_ROOT}/.tmp/offline-dependencies/${source_file}")
endif()
FetchContent_Declare(mediainfo_source
    URL "${source_url}"
    URL_HASH "SHA256=${source_hash}"
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(mediainfo_source)

set(BUILD_SHARED_LIBS ON)
set(BUILD_ZENLIB ON)
set(BUILD_ZLIB ON)
set(ZLIB_BUILD_SHARED OFF)
set(ZLIB_BUILD_STATIC ON)
set(ZLIB_BUILD_TESTING OFF)
set(CMAKE_DISABLE_FIND_PACKAGE_CURL ON)
set(CMAKE_DISABLE_FIND_PACKAGE_TinyXML ON)

# Disable only unused auxiliary functions. Every parser keeps upstream defaults.
# Reset the feature cache on each configure; stale local switches must not remove parsers.
get_cmake_property(cache_variables CACHE_VARIABLES)
foreach(variable IN LISTS cache_variables)
    if(variable MATCHES "^MEDIAINFO_[A-Z0-9_]+$")
        set(${variable} DEFAULT)
    endif()
endforeach()
string(JSON feature_count LENGTH "${profile}" disabledFeatures)
math(EXPR feature_last "${feature_count} - 1")
foreach(index RANGE 0 ${feature_last})
    string(JSON feature GET "${profile}" disabledFeatures ${index})
    set(MEDIAINFO_${feature} OFF)
endforeach()

if(MSVC)
    # Static CRT for both Release and Debug; no extra runtime DLL in the package.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    string(REPLACE "/O2" "/O1" CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE}")
    string(REPLACE "/O2" "/O1" CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE}")
endif()
add_subdirectory("${mediainfo_source_SOURCE_DIR}/MediaInfoLib/Project/CMake" upstream)
set_target_properties(mediainfo PROPERTIES
    OUTPUT_NAME MediaInfo
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
if(MSVC)
    foreach(target mediainfo zen zlibstatic)
        set_property(TARGET ${target} PROPERTY INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
        target_compile_options(${target} PRIVATE "$<$<CONFIG:Release>:/Gy;/Gw>")
    endforeach()
    target_link_options(mediainfo PRIVATE "$<$<CONFIG:Release>:/OPT:REF;/OPT:ICF>")
endif()

set(JAVM_MEDIAINFO_SOURCE_DIR "${mediainfo_source_SOURCE_DIR}" PARENT_SCOPE)
