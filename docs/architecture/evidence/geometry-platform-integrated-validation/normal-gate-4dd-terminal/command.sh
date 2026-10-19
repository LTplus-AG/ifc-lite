# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
unset IFCLITE_SMLIB_WORKER
results=()
run_case() {
  local case_name="$1"
  shift
  printf '\nCASE_START %s\n' "$case_name"
  "$@"
  local result=$?
  printf 'CASE_END %s exit=%s\n' "$case_name" "$result"
  results+=("$result")
}
run_case default_normal_core cargo build --locked -p ifc-lite-core --lib --no-default-features
run_case tracking_normal_core cargo build --locked -p ifc-lite-core --lib --no-default-features --features source-resource-tracking
run_case explicit_normal_core cargo build --locked -p ifc-lite-core --lib --no-default-features --features source-resource-gate-test-support
run_case core_combined_gate cargo test --locked -p ifc-lite-core --lib --features source-resource-gate-test-support normal_identity_actual_gate -- --nocapture
run_case all_core_resource cargo test --locked -p ifc-lite-core --lib --features source-resource-gate-test-support source_resources -- --nocapture
run_case geometry_combined_gate cargo test --locked -p ifc-lite-geometry --lib --features source-resource-gate-test-support gate_boundary_witnesses -- --nocapture
run_case geometry_resources cargo test --locked -p ifc-lite-geometry --lib --features source-resource-gate-test-support resource:: -- --nocapture
run_case wasm_core_test_compile cargo test --locked -p ifc-lite-core --lib --target wasm32-unknown-unknown --features source-resource-gate-test-support --no-run
run_case default_strict_clippy cargo clippy --workspace --all-targets -- -D warnings
run_case test_support_strict_clippy cargo clippy --workspace --all-targets --features ifc-lite-core/source-resource-gate-test-support -- -D warnings
printf 'SDK_ENV_UNSET_NOT_NUMERICAL_QUALIFICATION=1\n'
for result in "${results[@]}"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
