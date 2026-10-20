cmake_minimum_required(VERSION 3.25)
project(JAVM_PortabilityChecks LANGUAGES CXX)
enable_testing()

# 与应用构建保持一致：中文 MSVC 的 include 前缀可能被 CMake 按 ANSI 误读。
if(MSVC AND CMAKE_GENERATOR MATCHES "Ninja" AND
   CMAKE_CXX_CL_SHOWINCLUDES_PREFIX MATCHES "^娉ㄦ剰: 鍖呭惈鏂囦欢:")
    set(CMAKE_CL_SHOWINCLUDES_PREFIX "注意: 包含文件: ")
endif()

# 无应用宿主、外部依赖和数据库，只构建跨平台基础工具的安全夹具。
add_executable(javm_utf8_test utf8.cpp)
target_compile_features(javm_utf8_test PRIVATE cxx_std_20)
set_target_properties(javm_utf8_test PROPERTIES CXX_EXTENSIONS OFF)
if(MSVC)
    target_compile_options(javm_utf8_test PRIVATE /W4 /WX /permissive- /utf-8)
else()
    target_compile_options(javm_utf8_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME javm_utf8 COMMAND javm_utf8_test)
