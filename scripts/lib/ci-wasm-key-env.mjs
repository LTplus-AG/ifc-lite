/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The env part of the WASM build cache key (scripts/ci-wasm-cache.mjs), and
 * the check that the build ran in the env Plan keyed on.
 */

/**
 * Env the build reads. build-wasm.sh switches bundles and features on the
 * first five names; cargo, rustc, wasm-pack and the `cc` crate (in
 * Cargo.lock) read the rest. HOME, CARGO_HOME, RUSTUP_HOME, GITHUB_WORKSPACE
 * and the target-dir vars are here because rustc embeds source and OUT_DIR
 * paths under them in panic locations, so they change the bytes even when
 * nothing else does.
 *
 * Prefixes cover whole families so a new member cannot slip past: every
 * CARGO_BUILD_* (rustc, rustc-wrapper, rustflags, target, ...), every
 * CARGO_TARGET_* (any target's runner, linker, rustflags), CARGO_PROFILE_*,
 * CARGO_UNSTABLE_*, CARGO_ENCODED_*, CARGO_SOURCE_* (source replacement),
 * RUSTC_* (wrappers, bootstrap, linker), and the cc crate's per-target
 * spellings. Registry env (CARGO_REGISTRY_*, CARGO_REGISTRIES_*) is left out:
 * it can carry tokens, and Cargo.lock's checksums already pin what it serves.
 */
export const KEY_ENV_NAMES = [
  'DEBUG_GEOMETRY', 'BUILD_CORE', 'BUILD_THREADED', 'BUILD_WIDE', 'BUILD_RETAINED',
  'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTUP_TOOLCHAIN', 'CARGO_INCREMENTAL',
  'CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'CRATE_CC_NO_DEFAULTS',
  'TARGET_CC', 'TARGET_CXX', 'TARGET_AR', 'TARGET_CFLAGS', 'TARGET_CXXFLAGS',
  'HOST_CC', 'HOST_CXX', 'HOST_AR', 'HOST_CFLAGS', 'HOST_CXXFLAGS',
  'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'GITHUB_WORKSPACE',
  'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS',
];
export const KEY_ENV_PREFIXES = [
  'CARGO_BUILD_', 'CARGO_TARGET_', 'CARGO_PROFILE_', 'CARGO_UNSTABLE_', 'CARGO_ENCODED_', 'CARGO_SOURCE_',
  'RUSTC_', 'WASM_BINDGEN_', 'WASM_PACK_',
  'CC_', 'CXX_', 'AR_', 'CFLAGS_', 'CXXFLAGS_',
];
/** Never keyed (the plan logs its env lines): credentials cannot change the bytes. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * `env NAME="value"` / `env NAME unset` for every keyed var, sorted. Values
 * are JSON-quoted so one var is always one line, newlines included.
 */
export function envLines(env) {
  const names = new Set(KEY_ENV_NAMES);
  for (const name of Object.keys(env)) {
    if (!SECRET_NAME.test(name) && KEY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) names.add(name);
  }
  return [...names].sort().map((name) => (name in env ? `env ${name}=${JSON.stringify(env[name])}` : `env ${name} unset`));
}

/**
 * Differences between the env lines Plan keyed (`planText`) and `env`. The one
 * tolerated change is CARGO_INCREMENTAL going from unset to 0, which
 * Swatinem/rust-cache exports after Plan: it forces incremental off, which is
 * already the release profile's default, so the bytes cannot change.
 */
export function envDrift(planText, env) {
  const tolerated = (planned, now) => planned === 'env CARGO_INCREMENTAL unset' && now === 'env CARGO_INCREMENTAL="0"';
  const planned = planText.split('\n').filter(Boolean);
  const current = envLines(env);
  const byName = (lines) => new Map(lines.map((line) => [line.match(/^env ([^ =]+)/)[1], line]));
  const before = byName(planned);
  const after = byName(current);
  const drift = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(name) ?? `env ${name} unset`;
    const is = after.get(name) ?? `env ${name} unset`;
    if (was !== is && !tolerated(was, is)) drift.push(`${was} -> ${is}`);
  }
  return drift;
}
