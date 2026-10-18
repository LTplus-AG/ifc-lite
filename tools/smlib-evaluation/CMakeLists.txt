# SPDX-License-Identifier: MPL-2.0
cmake_minimum_required(VERSION 3.20)
project(ifclite_smlib_evaluation LANGUAGES CXX)

# Deliberately outside Cargo/pnpm: this evaluates replacement feasibility.
# SMLIB_SOURCE must be the revision recorded in upstream.json.
if(NOT IS_DIRECTORY "${SMLIB_SOURCE}/source/SMLib/src")
  message(FATAL_ERROR "Pass -DSMLIB_SOURCE=/path/to/usd-brep")
endif()
execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY "${SMLIB_SOURCE}"
  OUTPUT_VARIABLE SMLIB_REVISION OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/upstream.json" provenance)
string(JSON expected_revision GET "${provenance}" commit)
if(NOT SMLIB_REVISION STREQUAL expected_revision)
  message(FATAL_ERROR "Unexpected upstream revision: ${SMLIB_REVISION}")
endif()
execute_process(COMMAND git diff --quiet HEAD -- source/SMLib source/SM_API
  WORKING_DIRECTORY "${SMLIB_SOURCE}" RESULT_VARIABLE source_modified)
if(NOT source_modified EQUAL 0)
  message(FATAL_ERROR "SMLib/SM_API source differs from the pinned upstream revision")
endif()

file(GLOB kernel_sources CONFIGURE_DEPENDS "${SMLIB_SOURCE}/source/SMLib/src/*.cpp")
file(GLOB api_sources CONFIGURE_DEPENDS "${SMLIB_SOURCE}/source/SM_API/src/*.cpp")
add_library(smlib_probe_kernel STATIC ${kernel_sources})
target_include_directories(smlib_probe_kernel PUBLIC
  "${SMLIB_SOURCE}/source/SMLib/inc" "${SMLIB_SOURCE}/source/SM_API/inc")
target_compile_features(smlib_probe_kernel PUBLIC cxx_std_17)
# Upstream-supported switches; TBB/thread/global-cache macros stay disabled.
target_compile_definitions(smlib_probe_kernel PUBLIC SM_NO_DEBUG_CODE SM_NO_GFX_OUTPUT_CODE NDEBUG)
add_library(smlib_probe_api STATIC ${api_sources})
# Both projects have an inc/StdAfx.h: preserve upstream's per-project order.
target_include_directories(smlib_probe_api BEFORE PRIVATE "${SMLIB_SOURCE}/source/SM_API/inc")
target_link_libraries(smlib_probe_api PUBLIC smlib_probe_kernel)
add_executable(smlib_probe smoke.cpp)
target_link_libraries(smlib_probe PRIVATE smlib_probe_api)
if(EMSCRIPTEN)
  target_compile_options(smlib_probe_kernel PRIVATE -fexceptions)
  target_compile_options(smlib_probe_api PRIVATE -fexceptions)
  target_compile_options(smlib_probe PRIVATE -fexceptions)
  target_link_options(smlib_probe PRIVATE -fexceptions --no-entry
    "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608"
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,node,worker"
    "-sEXPORTED_FUNCTIONS=['_run_probe']" "-sEXPORTED_RUNTIME_METHODS=['UTF8ToString']")
  set_target_properties(smlib_probe PROPERTIES SUFFIX ".mjs")
endif()
