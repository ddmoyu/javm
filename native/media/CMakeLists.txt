include(FetchContent)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The media scanner currently targets Windows x64.")
endif()
FetchContent_Declare(pugixml
    URL "https://codeload.github.com/zeux/pugixml/zip/refs/tags/v1.16"
    URL_HASH SHA256=b418b8172c701e29fd8e369c02fb607167dcb2861a23f71b8014443e9a421a9e
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(pugixml)
add_subdirectory(mediainfo)
add_library(javm_media STATIC src/common.cpp src/nfo.cpp src/nfo_encoding.cpp src/nfo_fields.cpp src/probe.cpp src/store.cpp src/scanner.cpp src/maintenance.cpp src/legacy_import.cpp)
target_link_libraries(javm_media PUBLIC javm_sqlite nlohmann_json::nlohmann_json pugixml::pugixml ole32)
target_include_directories(javm_media PUBLIC src)
target_include_directories(javm_media SYSTEM PRIVATE "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/Source")
target_compile_definitions(javm_media PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
if(MSVC)
    target_compile_options(javm_media PRIVATE /W4 /permissive- /utf-8)
endif()
target_link_libraries(javm_database PRIVATE javm_media)
add_custom_target(javm_media_runtime ALL
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:mediainfo>" "${PROJECT_SOURCE_DIR}/bin/MediaInfo.dll"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${PROJECT_SOURCE_DIR}/bin/licenses"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/License.html" "${PROJECT_SOURCE_DIR}/bin/licenses/MediaInfo.html"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_SOURCE_DIR}/ZenLib/License.txt" "${PROJECT_SOURCE_DIR}/bin/licenses/ZenLib.txt"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_SOURCE_DIR}/zlib/LICENSE" "${PROJECT_SOURCE_DIR}/bin/licenses/zlib.txt"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${pugixml_SOURCE_DIR}/LICENSE.md" "${PROJECT_SOURCE_DIR}/bin/licenses/pugixml.txt"
    DEPENDS javm_database mediainfo)
if(JAVM_MEDIAINFO_PREBUILT)
    add_custom_command(TARGET javm_media_runtime POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_PREBUILT}/bin/MediaInfo.dll" "${CMAKE_BINARY_DIR}/bin/MediaInfo.dll"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${JAVM_MEDIAINFO_PREBUILT}/bin/mediainfo-lite.json" "${PROJECT_SOURCE_DIR}/bin/mediainfo-lite.json")
else()
    add_custom_command(TARGET javm_media_runtime POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            "-DBINARY=$<TARGET_FILE:mediainfo>"
            "-DDEPENDENCIES=${PROJECT_SOURCE_DIR}/scripts/offline-dependencies.json"
            "-DOUTPUT=$<TARGET_FILE_DIR:mediainfo>/mediainfo-lite.json"
            "-DBUILD_TYPE=$<CONFIG>"
            "-DCOMPILER=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/mediainfo/write-receipt.cmake"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE_DIR:mediainfo>/mediainfo-lite.json" "${PROJECT_SOURCE_DIR}/bin/mediainfo-lite.json")
endif()
