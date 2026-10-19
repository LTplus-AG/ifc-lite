# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
unset IFCLITE_SMLIB_WORKER
cargo test --locked -p ifc-lite-core --lib --features source-resource-tracking source_resources -- --nocapture
core_status=$?
cargo clippy --locked --workspace --all-targets --features ifc-lite-core/source-resource-tracking -- -D warnings
clippy_status=$?
cargo test --locked -p ifc-lite-core --lib --features source-resource-tracking --target wasm32-unknown-unknown --no-run
wasm_compile_status=$?
printf 'core_allocator_tests_exit=%s feature_workspace_clippy_exit=%s wasm_test_compile_exit=%s\n' "$core_status" "$clippy_status" "$wasm_compile_status"
for result in "$core_status" "$clippy_status" "$wasm_compile_status"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
