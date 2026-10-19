# SPDX-License-Identifier: MPL-2.0
cmake_minimum_required(VERSION 3.20)
project(ifclite_smlib_adapter LANGUAGES C CXX)
include(CTest)
find_program(NODE_TRANSPORT_EXECUTABLE node)
if(NODE_TRANSPORT_EXECUTABLE)
  add_test(NAME smlib_sweep_upload_transport COMMAND "${NODE_TRANSPORT_EXECUTABLE}" --test
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/sweep-transport.test.mjs"
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/client.test.mjs"
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/region-recipes.test.mjs"
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/mesh-witness.test.mjs")
  add_test(NAME retained_driver_protocol_lifetimes COMMAND "${NODE_TRANSPORT_EXECUTABLE}" --experimental-vm-modules --test
    "${CMAKE_CURRENT_SOURCE_DIR}/../../rust/geometry-runtime/js/retained-driver.test.mjs")
endif()
set(IFCLITE_SMLIB_REVISION c9c5979f04cea8c38213004d4f04df0dcfb40d05)
if(NOT IS_DIRECTORY "${SMLIB_SOURCE}/source/SMLib/src")
  message(FATAL_ERROR "Pass -DSMLIB_SOURCE=/path/to/usd-brep")
endif()
execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY "${SMLIB_SOURCE}"
  OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
if(NOT revision STREQUAL IFCLITE_SMLIB_REVISION)
  message(FATAL_ERROR "Unexpected SMLib revision ${revision}")
endif()
execute_process(COMMAND git diff --quiet HEAD -- source/SMLib source/SM_API
  WORKING_DIRECTORY "${SMLIB_SOURCE}" RESULT_VARIABLE modified)
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
add_library(ifclite_smlib STATIC src/adapter.cpp src/affine.cpp src/mesh.cpp src/sweep.cpp src/disk.cpp src/protocol.cpp)
target_include_directories(ifclite_smlib PUBLIC include)
target_link_libraries(ifclite_smlib PRIVATE smlib_api)
# Keep upstream C++ types/includes private to the adapter.
add_executable(ifclite_smlib_tests tests/adapter_tests.cpp tests/empty_tests.cpp tests/affine_tests.cpp tests/mesh_tests.cpp tests/sweep_tests.cpp tests/sweep_region_tests.cpp tests/disk_tests.cpp tests/c_header.c)
target_compile_features(ifclite_smlib_tests PRIVATE c_std_11 cxx_std_17)
target_link_libraries(ifclite_smlib_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_tests PRIVATE src)
if(NOT EMSCRIPTEN)
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
endif()
if(EMSCRIPTEN)
  add_executable(ifclite_smlib_browser src/browser.cpp)
  target_link_libraries(ifclite_smlib_browser PRIVATE ifclite_smlib)
  target_compile_options(ifclite_smlib_browser PRIVATE -fexceptions)
  target_link_options(ifclite_smlib_browser PRIVATE -fexceptions --no-entry
    "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608" "-sMODULARIZE=1"
    "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker,node"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_ifclite_smlib_dispatch_owned']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']")
  set_target_properties(ifclite_smlib_browser PROPERTIES SUFFIX ".mjs")
  foreach(module module worker client contract sweep sweep-contract lifecycle-contract mesh-witness region-recipes)
    configure_file("browser/${module}.mjs" "${module}.mjs" COPYONLY)
  endforeach()
  configure_file(browser/test.html test.html COPYONLY)
  foreach(fixture hung-worker missing-asset-worker)
    configure_file("browser/tests/${fixture}.mjs" "tests/${fixture}.mjs" COPYONLY)
  endforeach()
  foreach(target smlib_kernel smlib_api ifclite_smlib ifclite_smlib_tests)
    target_compile_options(${target} PRIVATE -fexceptions)
  endforeach()
  target_link_options(ifclite_smlib_tests PRIVATE -fexceptions
    "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608" "-sENVIRONMENT=node")
  set_target_properties(ifclite_smlib_tests PROPERTIES SUFFIX ".cjs")
  find_program(NODE_EXECUTABLE node REQUIRED)
  add_test(NAME smlib_browser_protocol COMMAND "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/node-tests.mjs"
    $<TARGET_FILE:ifclite_smlib_browser>)
  set_tests_properties(smlib_browser_protocol PROPERTIES TIMEOUT 60)
  add_test(NAME smlib_owned_boundary COMMAND "${NODE_EXECUTABLE}" $<TARGET_FILE:ifclite_smlib_tests>)
else()
  add_test(NAME smlib_owned_boundary COMMAND ifclite_smlib_tests)
endif()
set_tests_properties(smlib_owned_boundary PROPERTIES TIMEOUT 60)
