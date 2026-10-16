set(TARGET tsm-tts-server)
add_executable(${TARGET} tts_server.cpp)
target_link_libraries(${TARGET} PRIVATE llama llama-common mtmd ${CMAKE_THREAD_LIBS_INIT})
target_compile_features(${TARGET} PRIVATE cxx_std_17)
