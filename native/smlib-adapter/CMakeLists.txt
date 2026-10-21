# SPDX-License-Identifier: MPL-2.0
cmake_minimum_required(VERSION 3.20)
project(ifclite_smlib_adapter LANGUAGES C CXX)
include(CTest)
set(IFCLITE_SMLIB_REVISION c9c5979f04cea8c38213004d4f04df0dcfb40d05)
if(NOT IS_DIRECTORY "${SMLIB_SOURCE}/source/SMLib/src")
  message(FATAL_ERROR "Pass -DSMLIB_SOURCE=/path/to/usd-brep (checkout of ${IFCLITE_SMLIB_REVISION})")
endif()
execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY "${SMLIB_SOURCE}"
  OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
if(NOT revision STREQUAL IFCLITE_SMLIB_REVISION)
  message(FATAL_ERROR "Unexpected SMLib revision ${revision}")
endif()
execute_process(COMMAND git diff --quiet HEAD -- source/SMLib source/SM_API
  WORKING_DIRECTORY "${SMLIB_SOURCE}" RESULT_VARIABLE modified)
# Deliberately NO --exclude-standard: plain `--others` also lists ignored files
# (.gitignore, info/exclude and global excludes are not consulted), so an ignored
# extra .cpp that the file(GLOB) below would compile still fails this check.
execute_process(COMMAND git ls-files --others -- source/SMLib source/SM_API
  WORKING_DIRECTORY "${SMLIB_SOURCE}" OUTPUT_VARIABLE untracked
  COMMAND_ERROR_IS_FATAL ANY)
if(NOT modified EQUAL 0 OR NOT untracked STREQUAL "")
  message(FATAL_ERROR "Pinned SMLib/SM_API sources have modifications")
endif()
file(GLOB kernel_sources CONFIGURE_DEPENDS "${SMLIB_SOURCE}/source/SMLib/src/*.cpp")
file(GLOB api_sources CONFIGURE_DEPENDS "${SMLIB_SOURCE}/source/SM_API/src/*.cpp")
add_library(smlib_kernel STATIC ${kernel_sources})
target_include_directories(smlib_kernel PUBLIC "${SMLIB_SOURCE}/source/SMLib/inc"
  "${SMLIB_SOURCE}/source/SM_API/inc")
target_compile_features(smlib_kernel PUBLIC cxx_std_17)
target_compile_definitions(smlib_kernel PUBLIC SM_NO_DEBUG_CODE SM_NO_GFX_OUTPUT_CODE NDEBUG)
add_library(smlib_api STATIC ${api_sources})
target_include_directories(smlib_api BEFORE PRIVATE "${SMLIB_SOURCE}/source/SM_API/inc")
target_link_libraries(smlib_api PUBLIC smlib_kernel)
# Upstream C++ types/includes stay private to the adapter.
add_library(ifclite_smlib STATIC src/adapter.cpp src/copy.cpp src/affine.cpp src/mesh.cpp
  src/sweep.cpp src/disk.cpp src/protocol.cpp)
target_include_directories(ifclite_smlib PUBLIC include)
target_link_libraries(ifclite_smlib PRIVATE smlib_api)

add_executable(ifclite_smlib_tests tests/adapter_tests.cpp tests/mesh_tests.cpp
  tests/empty_tests.cpp tests/affine_tests.cpp tests/context_metadata_tests.cpp tests/c_header.c)
target_compile_features(ifclite_smlib_tests PRIVATE c_std_11 cxx_std_17)
target_link_libraries(ifclite_smlib_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_tests PRIVATE src)
add_test(NAME smlib_owned_boundary COMMAND ifclite_smlib_tests)

# Terminal copy failure taints the process: keep it in its own executable.
add_executable(ifclite_smlib_copy_failure_tests tests/copy_failure_tests.cpp)
target_compile_features(ifclite_smlib_copy_failure_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_copy_failure_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_copy_failure_tests PRIVATE src)
add_test(NAME smlib_copy_failure_boundary COMMAND ifclite_smlib_copy_failure_tests)
# A failed affine copy taints its own process, separately from the copy lane.
add_test(NAME smlib_affine_failure_boundary COMMAND ifclite_smlib_copy_failure_tests affine)

# Staged authored recipes: actual SDK regions, full circles, trims and disks.
add_executable(ifclite_smlib_sweep_tests tests/sweep_tests.cpp tests/sweep_region_tests.cpp
  tests/disk_tests.cpp)
target_compile_features(ifclite_smlib_sweep_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_sweep_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_sweep_tests PRIVATE src)
add_test(NAME smlib_retained_sweeps COMMAND ifclite_smlib_sweep_tests)
set_tests_properties(smlib_owned_boundary smlib_copy_failure_boundary
  smlib_affine_failure_boundary smlib_retained_sweeps PROPERTIES TIMEOUT 60)

add_executable(ifclite_smlib_worker src/worker.cpp)
target_link_libraries(ifclite_smlib_worker PRIVATE ifclite_smlib)
find_package(Python3 COMPONENTS Interpreter QUIET)
if(Python3_Interpreter_FOUND)
  add_test(NAME smlib_worker_framing COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/worker_tests.py" $<TARGET_FILE:ifclite_smlib_worker>)
  set_tests_properties(smlib_worker_framing PROPERTIES TIMEOUT 60)
else()
  message(STATUS "Python3 unavailable: standalone worker framing test omitted")
endif()
