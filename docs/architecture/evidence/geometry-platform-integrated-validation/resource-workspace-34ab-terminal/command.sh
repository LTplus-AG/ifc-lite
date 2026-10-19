# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm fixtures || exit $?
pnpm fixtures:check || exit $?
unset IFCLITE_SMLIB_WORKER
cargo test --locked -p ifc-lite-core --lib --features source-resource-tracking source_resources -- --nocapture
core_status=$?
cargo test --locked -p ifc-lite-geometry --lib --features source-resource-tracking,test-support resource:: -- --nocapture
geometry_status=$?
cargo test --workspace --no-fail-fast
workspace_status=$?
cargo clippy --workspace --all-targets -- -D warnings
clippy_status=$?
cargo clippy --workspace --all-targets --features ifc-lite-core/source-resource-tracking -- -D warnings
feature_clippy_status=$?
cargo test --locked -p ifc-lite-core --lib --features source-resource-tracking --target wasm32-unknown-unknown --no-run
wasm_status=$?
printf 'actual_account_core_exit=%s geometry_resources_exit=%s default_workspace_exit=%s default_strict_clippy_exit=%s feature_strict_clippy_exit=%s wasm_core_test_compile_exit=%s SDK_ENV_UNSET_NOT_NUMERICAL_QUALIFICATION=1\n' "$core_status" "$geometry_status" "$workspace_status" "$clippy_status" "$feature_clippy_status" "$wasm_status"
for result in "$core_status" "$geometry_status" "$workspace_status" "$clippy_status" "$feature_clippy_status" "$wasm_status"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
