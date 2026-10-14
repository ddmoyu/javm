include(FetchContent)

# 只编译官方 SQLite amalgamation，不引入数据库 CLI 或 Node 原生插件。
FetchContent_Declare(sqlite
    URL "https://sqlite.org/2026/sqlite-amalgamation-3530400.zip"
    URL_HASH SHA3_256=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(sqlite)

FetchContent_Declare(nlohmann_json
    URL "https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz"
    URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

add_library(javm_sqlite STATIC "${sqlite_SOURCE_DIR}/sqlite3.c")
target_include_directories(javm_sqlite SYSTEM PUBLIC "${sqlite_SOURCE_DIR}")
target_compile_definitions(javm_sqlite PRIVATE SQLITE_THREADSAFE=1)

if(UNIX)
    find_package(Threads REQUIRED)
    target_link_libraries(javm_sqlite PUBLIC Threads::Threads ${CMAKE_DL_LIBS} m)
endif()

add_executable(javm_database src/main.cpp)
target_link_libraries(javm_database PRIVATE javm_sqlite nlohmann_json::nlohmann_json)
if(WIN32)
    target_link_libraries(javm_database PRIVATE winhttp ole32 iphlpapi ws2_32 user32)
    target_compile_definitions(javm_database PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
if(JAVM_EXTENSION_TRANSPORT STREQUAL "winhttp")
    target_sources(javm_database PRIVATE src/extension_winhttp.cpp)
else()
    find_package(Threads REQUIRED)
    target_sources(javm_database PRIVATE src/extension_curl.cpp)
    target_link_libraries(javm_database PRIVATE CURL::libcurl Threads::Threads)
endif()
target_compile_definitions(javm_database PRIVATE
    JAVM_VERSION="${JAVM_APP_VERSION}"
    JAVM_WITH_MEDIA=$<NOT:$<BOOL:${JAVM_CORE_ONLY}>>
    JAVM_USE_WINHTTP=$<STREQUAL:${JAVM_EXTENSION_TRANSPORT},winhttp>)
set_target_properties(javm_database PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
if(JAVM_CORE_ONLY)
    # 开发夹具不能覆盖桌面应用所需的完整媒体扩展。
    set_target_properties(javm_database PROPERTIES OUTPUT_NAME javm_database_core)
    if(WIN32)
        # 同时编译完整 Windows 入口，检查媒体分支没有被条件编译误伤；不链接或部署。
        add_library(javm_windows_dispatch_check OBJECT src/main.cpp)
        target_link_libraries(javm_windows_dispatch_check PRIVATE javm_sqlite nlohmann_json::nlohmann_json)
        target_include_directories(javm_windows_dispatch_check PRIVATE ../media/src ../http/src)
        target_compile_definitions(javm_windows_dispatch_check PRIVATE
            JAVM_VERSION="${JAVM_APP_VERSION}" JAVM_WITH_MEDIA=1 JAVM_USE_WINHTTP=1
            UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
        if(MSVC)
            target_compile_options(javm_windows_dispatch_check PRIVATE /W4 /permissive- /utf-8)
        endif()
    endif()
else()
    add_custom_command(TARGET javm_database POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${PROJECT_SOURCE_DIR}/bin"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:javm_database>" "${PROJECT_SOURCE_DIR}/bin/$<TARGET_FILE_NAME:javm_database>")
endif()

if(MSVC)
    target_compile_options(javm_database PRIVATE /W4 /permissive- /utf-8)
    target_compile_options(javm_sqlite PRIVATE /utf-8)
else()
    target_compile_options(javm_database PRIVATE -Wall -Wextra -Wpedantic)
endif()
