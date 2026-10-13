include(FetchContent)
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The media scanner requires a 64-bit target.")
endif()
FetchContent_Declare(pugixml
    URL "https://codeload.github.com/zeux/pugixml/zip/refs/tags/v1.16"
    URL_HASH SHA256=b418b8172c701e29fd8e369c02fb607167dcb2861a23f71b8014443e9a421a9e
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(pugixml)
add_library(javm_media STATIC src/common.cpp src/file_platform.cpp src/text_platform.cpp src/nfo.cpp src/nfo_encoding.cpp src/nfo_fields.cpp src/probe.cpp src/store.cpp src/scanner.cpp src/maintenance.cpp src/legacy_import.cpp)
target_link_libraries(javm_media PUBLIC javm_sqlite nlohmann_json::nlohmann_json pugixml::pugixml javm_probe)
target_include_directories(javm_media PUBLIC src)
if(WIN32)
    target_link_libraries(javm_media PUBLIC ole32)
    target_compile_definitions(javm_media PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    find_package(Iconv REQUIRED)
    find_package(ICU REQUIRED COMPONENTS uc i18n)
    target_link_libraries(javm_media PUBLIC Iconv::Iconv ICU::uc ICU::i18n)
    if(APPLE)
        target_compile_definitions(javm_media PRIVATE _DARWIN_C_SOURCE)
    else()
        target_compile_definitions(javm_media PRIVATE _GNU_SOURCE)
    endif()
endif()
if(MSVC)
    target_compile_options(javm_media PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(javm_media PRIVATE -Wall -Wextra -Wpedantic)
endif()
if(JAVM_CORE_ONLY)
    include(tests.cmake)
    return()
endif()
if(JAVM_USE_PREBUILT_DEPENDENCIES)
    add_library(mediainfo SHARED IMPORTED GLOBAL)
    set_target_properties(mediainfo PROPERTIES
        IMPORTED_LOCATION "${JAVM_PREBUILT_MEDIAINFO}/runtime/MediaInfo.dll")
    set(JAVM_MEDIAINFO_INCLUDE_DIR "${JAVM_PREBUILT_MEDIAINFO}/sdk/include")
    set(JAVM_MEDIAINFO_RECEIPT "${JAVM_PREBUILT_MEDIAINFO}/runtime/mediainfo-lite.json")
    set(JAVM_MEDIAINFO_LICENSE "${JAVM_PREBUILT_MEDIAINFO}/licenses/MediaInfo.html")
    set(JAVM_ZENLIB_LICENSE "${JAVM_PREBUILT_MEDIAINFO}/licenses/ZenLib.txt")
    set(JAVM_ZLIB_LICENSE "${JAVM_PREBUILT_MEDIAINFO}/licenses/zlib.txt")
else()
    add_subdirectory(mediainfo)
    set(JAVM_MEDIAINFO_INCLUDE_DIR "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/Source")
    set(JAVM_MEDIAINFO_RECEIPT "$<TARGET_FILE_DIR:mediainfo>/mediainfo-lite.json")
    set(JAVM_MEDIAINFO_LICENSE "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/License.html")
    set(JAVM_ZENLIB_LICENSE "${JAVM_MEDIAINFO_SOURCE_DIR}/ZenLib/License.txt")
    set(JAVM_ZLIB_LICENSE "${JAVM_MEDIAINFO_SOURCE_DIR}/zlib/LICENSE")
    set(JAVM_MEDIAINFO_RECEIPT_COMMAND
        COMMAND ${CMAKE_COMMAND}
            "-DBINARY=$<TARGET_FILE:mediainfo>"
            "-DDEPENDENCIES=${PROJECT_SOURCE_DIR}/scripts/offline-dependencies.json"
            "-DOUTPUT=${JAVM_MEDIAINFO_RECEIPT}"
            "-DBUILD_TYPE=$<CONFIG>"
            "-DCOMPILER=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/mediainfo/write-receipt.cmake")
endif()
target_link_libraries(javm_database PRIVATE javm_media)
add_custom_target(javm_media_runtime ALL
    ${JAVM_MEDIAINFO_RECEIPT_COMMAND}
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:mediainfo>" "${PROJECT_SOURCE_DIR}/bin/MediaInfo.dll"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:mediainfo>" "$<TARGET_FILE_DIR:javm_database>/MediaInfo.dll"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_RECEIPT}" "${PROJECT_SOURCE_DIR}/bin/mediainfo-lite.json"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_RECEIPT}" "$<TARGET_FILE_DIR:javm_database>/mediainfo-lite.json"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${PROJECT_SOURCE_DIR}/bin/licenses"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_LICENSE}" "${PROJECT_SOURCE_DIR}/bin/licenses/MediaInfo.html"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_ZENLIB_LICENSE}" "${PROJECT_SOURCE_DIR}/bin/licenses/ZenLib.txt"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_ZLIB_LICENSE}" "${PROJECT_SOURCE_DIR}/bin/licenses/zlib.txt"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${pugixml_SOURCE_DIR}/LICENSE.md" "${PROJECT_SOURCE_DIR}/bin/licenses/pugixml.txt"
    DEPENDS javm_database mediainfo)
