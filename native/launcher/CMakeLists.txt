if(UNIX AND NOT JAVM_CORE_ONLY)
    add_executable(javm_launcher src/main.cpp)
if(APPLE)
    enable_language(OBJCXX)
    target_sources(javm_launcher PRIVATE src/main_macos.mm)
    target_compile_options(javm_launcher PRIVATE "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>")
    target_link_libraries(javm_launcher PRIVATE "-framework AppKit")
endif()
    target_compile_options(javm_launcher PRIVATE -Wall -Wextra -Wpedantic)
    set_target_properties(javm_launcher PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
    add_custom_command(TARGET javm_launcher POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${PROJECT_SOURCE_DIR}/bin"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:javm_launcher>" "${PROJECT_SOURCE_DIR}/bin/javm_launcher")
endif()
