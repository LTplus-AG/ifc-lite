# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm fixtures || exit $?
pnpm fixtures:check || exit $?
unset IFCLITE_SMLIB_WORKER
cargo clippy --workspace --all-targets -- -D warnings
default_status=$?
cargo clippy --workspace --all-targets --features ifc-lite-core/source-resource-tracking -- -D warnings
feature_status=$?
printf 'default_clippy_exit=%s allocator_feature_clippy_exit=%s\n' "$default_status" "$feature_status"
if [ "$default_status" -ne 0 ]; then exit "$default_status"; fi
exit "$feature_status"
