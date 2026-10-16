@echo off
rem Build tsm-tts-server: drop native\tts-server into llama.cpp (pinned commit) and build that one target.
rem The only source of truth is native\tts-server. The llama.cpp tree is fetched when missing (not stored in the repo).
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set LLAMA_COMMIT=10da8c4
cd /d %~dp0
if not exist llama.cpp\.git (
  git clone https://github.com/ggml-org/llama.cpp.git llama.cpp || exit /b 1
  git -C llama.cpp checkout %LLAMA_COMMIT% || exit /b 1
)
git -C llama.cpp apply --check ..\llama-cpp-tools.patch >nul 2>&1 && git -C llama.cpp apply ..\llama-cpp-tools.patch
xcopy /y /i /q tts-server llama.cpp\tools\tts-server >nul || exit /b 1
cd llama.cpp
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_CUDA=OFF -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl || exit /b 1
cmake --build build --target tsm-tts-server -j 16 || exit /b 1
copy /y build\bin\tsm-tts-server.exe ..\..\app\native\tsm-tts-server.exe >nul
echo BUILD_OK
