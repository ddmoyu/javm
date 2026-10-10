enable_language(RC)
configure_file(launcher.rc.in "${CMAKE_CURRENT_BINARY_DIR}/launcher.rc" @ONLY)
add_executable(javm_launcher WIN32 main.cpp "${CMAKE_CURRENT_BINARY_DIR}/launcher.rc")
target_compile_definitions(javm_launcher PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(javm_launcher PRIVATE /W4 /permissive- /utf-8)
set_target_properties(javm_launcher PROPERTIES OUTPUT_NAME "JAVM"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_custom_command(TARGET javm_launcher POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${PROJECT_SOURCE_DIR}/bin"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:javm_launcher>" "${PROJECT_SOURCE_DIR}/bin/JAVM.exe")
