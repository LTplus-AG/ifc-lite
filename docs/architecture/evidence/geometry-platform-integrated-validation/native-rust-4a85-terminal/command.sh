# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm fixtures || exit $?
pnpm fixtures:check || exit $?
bash /home/louistrue/build-workers/setup/projects-20261017/ifc-lite/env-exec.sh bash native/smlib-adapter/qualify.sh native --rust-consumers
native_status=$?
unset IFCLITE_SMLIB_WORKER
cargo test --workspace --no-fail-fast
workspace_status=$?
cargo clippy --workspace --all-targets -- -D warnings
clippy_status=$?
printf 'native_ctest_and_consumers_exit=%s exact_workspace_exit=%s clippy_exit=%s\n' "$native_status" "$workspace_status" "$clippy_status"
if [ "$native_status" -ne 0 ]; then exit "$native_status"; fi
if [ "$workspace_status" -ne 0 ]; then exit "$workspace_status"; fi
exit "$clippy_status"
