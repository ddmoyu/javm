cmake_minimum_required(VERSION 3.25)
project(JAVM_MediaInfo LANGUAGES C CXX)
get_filename_component(JAVM_REPOSITORY_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
add_subdirectory("${JAVM_REPOSITORY_ROOT}/native/media/mediainfo" mediainfo)
install(TARGETS mediainfo RUNTIME DESTINATION runtime LIBRARY DESTINATION runtime)
install(DIRECTORY "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/Source/MediaInfoDLL"
    DESTINATION sdk/include FILES_MATCHING PATTERN "*.h")
install(FILES "${JAVM_MEDIAINFO_SOURCE_DIR}/MediaInfoLib/License.html"
    DESTINATION licenses RENAME MediaInfo.html)
install(FILES "${JAVM_MEDIAINFO_SOURCE_DIR}/ZenLib/License.txt"
    DESTINATION licenses RENAME ZenLib.txt)
install(FILES "${JAVM_MEDIAINFO_SOURCE_DIR}/zlib/LICENSE"
    DESTINATION licenses RENAME zlib.txt)
add_custom_target(javm_mediainfo_receipt ALL
    COMMAND ${CMAKE_COMMAND}
        "-DBINARY=$<TARGET_FILE:mediainfo>"
        "-DDEPENDENCIES=${JAVM_REPOSITORY_ROOT}/scripts/offline-dependencies.json"
        "-DOUTPUT=${CMAKE_BINARY_DIR}/mediainfo-lite.json"
        "-DBUILD_TYPE=$<CONFIG>"
        "-DCOMPILER=${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
        -P "${JAVM_REPOSITORY_ROOT}/native/media/mediainfo/write-receipt.cmake"
    DEPENDS mediainfo)
install(FILES "${CMAKE_BINARY_DIR}/mediainfo-lite.json" DESTINATION runtime)
