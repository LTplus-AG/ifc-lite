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
  src/affine_rational.cpp src/affine_transition.cpp src/affine_transition_state.cpp
  src/owned_lineage.cpp src/face_lineage.cpp src/face_lineage_events.cpp src/face_lineage_geometry.cpp src/face_lineage_read.cpp src/numerical_tessellation.cpp
  src/generated_plane.cpp src/representation_seal.cpp src/representation_seal_geometry.cpp
  src/planar_transition.cpp src/planar_transition_events.cpp src/planar_transition_plan.cpp
  src/planar_transition_verify.cpp
  src/sweep.cpp src/disk.cpp src/protocol.cpp src/plane.cpp src/plane_accuracy.cpp src/plane_domain.cpp src/plane_source_domain.cpp src/plane_inventory.cpp src/plane_owned_domain.cpp)
# Interval proofs require directed outward rounding without contraction.
if(MSVC)
  set_source_files_properties(src/plane.cpp src/plane_domain.cpp src/plane_source_domain.cpp src/plane_inventory.cpp src/plane_owned_domain.cpp PROPERTIES COMPILE_OPTIONS "/fp:strict")
else()
  set_source_files_properties(src/plane.cpp src/plane_domain.cpp src/plane_source_domain.cpp src/plane_inventory.cpp src/plane_owned_domain.cpp PROPERTIES COMPILE_OPTIONS "-fno-fast-math;-ffp-contract=off")
endif()
target_include_directories(ifclite_smlib PUBLIC include)
target_link_libraries(ifclite_smlib PRIVATE smlib_api)

add_executable(ifclite_smlib_tests tests/adapter_tests.cpp tests/mesh_tests.cpp
  tests/plane_tests.cpp tests/plane_preflight_tests.cpp tests/empty_tests.cpp tests/affine_tests.cpp tests/context_metadata_tests.cpp tests/c_header.c)
target_compile_features(ifclite_smlib_tests PRIVATE c_std_11 cxx_std_17)
target_link_libraries(ifclite_smlib_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_tests PRIVATE src)

add_executable(ifclite_smlib_plane_oracle_tests tests/plane_oracle_tests.cpp tests/patch_accuracy_diagnostic.cpp tests/patch_edge_oracle.cpp)
target_compile_features(ifclite_smlib_plane_oracle_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_plane_oracle_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_plane_oracle_tests PRIVATE src)

add_executable(ifclite_smlib_plane_chain_tests tests/plane_chain_tests.cpp)
target_compile_features(ifclite_smlib_plane_chain_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_plane_chain_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_plane_chain_tests PRIVATE src)

add_executable(ifclite_smlib_plane_owned_tests tests/plane_owned_domain_tests.cpp)
target_compile_features(ifclite_smlib_plane_owned_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_plane_owned_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_plane_owned_tests PRIVATE src)

# Terminal copy failure taints the process: keep it in its own executable.
add_executable(ifclite_smlib_copy_failure_tests tests/copy_failure_tests.cpp)
target_compile_features(ifclite_smlib_copy_failure_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_copy_failure_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_copy_failure_tests PRIVATE src)

# Staged authored recipes: actual SDK regions, full circles, trims and disks.
add_executable(ifclite_smlib_sweep_tests tests/sweep_tests.cpp tests/sweep_region_tests.cpp
  tests/disk_tests.cpp)
target_compile_features(ifclite_smlib_sweep_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_sweep_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_sweep_tests PRIVATE src)

# J5 private topology evidence; terminal budget witness stays process-isolated.
add_executable(ifclite_smlib_lineage_tests tests/lineage_main.cpp
  tests/numerical_trim_tests.cpp tests/face_lineage_tests.cpp tests/root_issuance_tests.cpp tests/owned_lineage_tests.cpp
  tests/owned_lineage_terminal_tests.cpp tests/affine_lineage_diagnostic_tests.cpp tests/affine_representation_diagnostic_tests.cpp tests/affine_lineage_positive_tests.cpp
  tests/affine_lineage_negative_tests.cpp tests/affine_lineage_curved_tests.cpp)
target_compile_features(ifclite_smlib_lineage_tests PRIVATE cxx_std_17)
target_link_libraries(ifclite_smlib_lineage_tests PRIVATE ifclite_smlib smlib_api)
target_include_directories(ifclite_smlib_lineage_tests PRIVATE src)

# Owned boundaries run natively, or under Node for the Emscripten build.
set(test_runner)
if(EMSCRIPTEN)
  # Test-only fixture module: real SDK/adapter in a real Worker, no test opcode
  # or fixture insertion path in the production ABI or staged product bundle.
  add_executable(ifclite_smlib_patch_accuracy_worker tests/plane_oracle_tests.cpp
    tests/patch_accuracy_diagnostic.cpp tests/patch_edge_oracle.cpp)
  target_compile_features(ifclite_smlib_patch_accuracy_worker PRIVATE cxx_std_17)
  target_compile_definitions(ifclite_smlib_patch_accuracy_worker PRIVATE IFCLITE_PATCH_ACCURACY_WORKER)
  target_include_directories(ifclite_smlib_patch_accuracy_worker PRIVATE src)
  target_link_libraries(ifclite_smlib_patch_accuracy_worker PRIVATE ifclite_smlib smlib_api)
  target_compile_options(ifclite_smlib_patch_accuracy_worker PRIVATE -fexceptions)
  target_link_options(ifclite_smlib_patch_accuracy_worker PRIVATE --no-entry -fexceptions
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker"
    "-sEXPORTED_FUNCTIONS=['_ifclite_patch_accuracy_test']"
    "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608")
  set_target_properties(ifclite_smlib_patch_accuracy_worker PROPERTIES SUFFIX ".mjs")
  # Browser module-Worker build: one owned-buffer dispatch export, no stdio.
  add_executable(ifclite_smlib_browser src/browser.cpp)
  target_link_libraries(ifclite_smlib_browser PRIVATE ifclite_smlib)
  target_link_options(ifclite_smlib_browser PRIVATE --no-entry
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker,node"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_ifclite_smlib_dispatch_owned']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']")
  set_target_properties(ifclite_smlib_browser PROPERTIES SUFFIX ".mjs")
  # The staged /smlib bundle is these exact module bytes beside the binary.
  foreach(module module worker client contract sweep sweep-contract dependency-contract normal-contract)
    configure_file("browser/${module}.mjs" "${module}.mjs" COPYONLY)
  endforeach()
  foreach(target smlib_kernel smlib_api ifclite_smlib ifclite_smlib_browser ifclite_smlib_tests
      ifclite_smlib_copy_failure_tests ifclite_smlib_sweep_tests ifclite_smlib_plane_oracle_tests ifclite_smlib_plane_chain_tests ifclite_smlib_lineage_tests ifclite_smlib_plane_owned_tests)
    target_compile_options(${target} PRIVATE -fexceptions)
  endforeach()
  target_link_options(ifclite_smlib_browser PRIVATE -fexceptions
    "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608")
  foreach(target ifclite_smlib_tests ifclite_smlib_copy_failure_tests ifclite_smlib_sweep_tests ifclite_smlib_plane_oracle_tests ifclite_smlib_plane_chain_tests ifclite_smlib_lineage_tests ifclite_smlib_plane_owned_tests)
    target_link_options(${target} PRIVATE -fexceptions
      "-sALLOW_MEMORY_GROWTH=1" "-sSTACK_SIZE=8388608" "-sENVIRONMENT=node")
    set_target_properties(${target} PROPERTIES SUFFIX ".cjs")
  endforeach()
  find_program(NODE_EXECUTABLE node REQUIRED)
  set(test_runner "${NODE_EXECUTABLE}")
  # The actual browser binary under Node: same dispatch, two independent
  # module instances, the shared sweep witness and malformed-frame refusal.
  add_test(NAME smlib_browser_protocol COMMAND "${NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/browser/node-tests.mjs" $<TARGET_FILE:ifclite_smlib_browser>)
  set_tests_properties(smlib_browser_protocol PROPERTIES TIMEOUT 120)
else()
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
add_test(NAME smlib_owned_boundary COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_tests>)
add_test(NAME smlib_copy_failure_boundary
  COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_copy_failure_tests>)
# A failed affine copy taints its own process, separately from the copy lane.
add_test(NAME smlib_affine_failure_boundary
  COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_copy_failure_tests> affine)
add_test(NAME smlib_retained_sweeps COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_sweep_tests>)
set_tests_properties(smlib_owned_boundary smlib_copy_failure_boundary
  smlib_affine_failure_boundary smlib_retained_sweeps PROPERTIES TIMEOUT 60)

add_test(NAME smlib_plane_cylinder_oracle COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_plane_oracle_tests> cylinder)
add_test(NAME smlib_plane_patch_oracle COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_plane_oracle_tests> patch)
set_tests_properties(smlib_plane_cylinder_oracle smlib_plane_patch_oracle PROPERTIES TIMEOUT 60)

add_test(NAME smlib_plane_chain_oracle COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_plane_chain_tests>)
set_tests_properties(smlib_plane_chain_oracle PROPERTIES TIMEOUT 60)

add_test(NAME smlib_native_face_lineage COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_lineage_tests>)
set_tests_properties(smlib_native_face_lineage PROPERTIES TIMEOUT 120)

# Every terminal witness gets a fresh process / Emscripten module; never reset.
foreach(case terminal-faces terminal-tessellate terminal-ancestors terminal-copy moved)
  add_test(NAME smlib_owned_lineage_${case}
    COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_lineage_tests> ${case})
  set_tests_properties(smlib_owned_lineage_${case} PROPERTIES TIMEOUT 120)
endforeach()
add_test(NAME smlib_plane_patch_edge_oracle COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_plane_oracle_tests> patch-edge)
set_tests_properties(smlib_plane_patch_edge_oracle PROPERTIES TIMEOUT 60)
add_test(NAME smlib_plane_owned_domain COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_plane_owned_tests>)
set_tests_properties(smlib_plane_owned_domain PROPERTIES TIMEOUT 60)

# Affine ancestry and process-isolated terminal witnesses.
foreach(case invalid representation callback positive curved mixed negative-source negative-sibling negative-target negative-receipt negative-late)
  add_test(NAME smlib_affine_lineage_diagnostic_${case}
    COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_lineage_tests> affine-${case})
  set_tests_properties(smlib_affine_lineage_diagnostic_${case} PROPERTIES TIMEOUT 120)
endforeach()

# Explicit Linux diagnostic checkpoint; never an event-acceptance capability.
option(IFCLITE_LINEAGE_FAILURE_STACK "Capture bounded first-failure native stacks" OFF)
if(IFCLITE_LINEAGE_FAILURE_STACK)
  if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR EMSCRIPTEN)
    message(FATAL_ERROR "Lineage failure stacks require native Linux execinfo")
  endif()
  target_sources(ifclite_smlib PRIVATE src/face_lineage_failure_stack.cpp)
  target_compile_definitions(ifclite_smlib PUBLIC IFCLITE_LINEAGE_FAILURE_STACK=1)
  add_executable(ifclite_smlib_failure_stack_tests tests/failure_stack_tests.cpp)
  target_compile_features(ifclite_smlib_failure_stack_tests PRIVATE cxx_std_17)
  target_include_directories(ifclite_smlib_failure_stack_tests PRIVATE src)
  target_link_libraries(ifclite_smlib_failure_stack_tests PRIVATE ifclite_smlib smlib_api)
  add_test(NAME smlib_lineage_failure_stack COMMAND ifclite_smlib_failure_stack_tests)
  set_tests_properties(smlib_lineage_failure_stack PROPERTIES TIMEOUT 30)
endif()

foreach(case positive reuse original origin owner leak frame)
  add_test(NAME smlib_numerical_trim_${case}
    COMMAND ${test_runner} $<TARGET_FILE:ifclite_smlib_lineage_tests> trim-${case})
  set_tests_properties(smlib_numerical_trim_${case} PROPERTIES TIMEOUT 120)
endforeach()
