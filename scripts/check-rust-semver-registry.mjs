#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The crates.io half of scripts/check-rust-semver.mjs, with no cargo at all.
 *
 * WHY. The semver gate only calls cargo-semver-checks for a crate whose
 * workspace version is ahead of its latest crates.io release. On an ordinary
 * PR every crate is already published at the workspace version, so the gate
 * decides from registry lookups alone, yet the `rust-semver` job still
 * installed a toolchain and restored a cargo cache first (p90 6.5 min).
 *
 * WHAT. This runs the gate's own `checkRustSemver` with runners that only
 * record that they were asked. Every refusal (BAD_VERSION, NO_CRATES,
 * CRATE_FLOOR, NO_BASELINE, BAD_BASELINE, VERSION_NOT_ADVANCED) and every
 * "already published" decision is made before a runner is called. So:
 *
 *   - no runner asked: the result IS the full gate's result, printed by the
 *     gate's own `report`. Exit 0 or 1, the same output.
 *   - a runner asked:  exit NEEDS_TOOL_EXIT (3). The stub's answer is thrown
 *     away and the caller must install the tool and run the full gate.
 *   - registry lookup failed: exit 2 with REGISTRY_LOOKUP_FAILED, as the full
 *     gate does.
 *
 * One decision path, so this cannot drift from the gate. It never prints a
 * compatibility result: one needs a comparison, and a comparison exits 3.
 *
 * Run: `node scripts/check-rust-semver-registry.mjs` (test.yml `rust-semver`)
 * Tests: scripts/check-rust-semver-registry.test.mjs
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRATES } from './lib/crates-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { checkRustSemver, loadPublishedBaselines, readVersionOrNull, report } from './check-rust-semver.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Exit status meaning "this verdict needs cargo-semver-checks; run the full gate". */
export const NEEDS_TOOL_EXIT = 3;

/**
 * The gate's verdict from the registry alone, or `{ needsTool: true }`.
 *
 * @param {{ crates: string[]|null, workspaceVersion: string|null, latestPublished: (crate: string) => string|null }} input
 * @returns {{ needsTool: true } | { needsTool: false, result: ReturnType<typeof checkRustSemver> }}
 */
export function registryOnlyVerdict({ crates, workspaceVersion, latestPublished }) {
  let asked = false;
  const ask = () => {
    asked = true;
    return { status: 1, output: '', via: null };
  };
  const result = checkRustSemver({ crates, workspaceVersion, latestPublished, runSemverChecks: ask, runTagBaseline: ask });
  return asked ? { needsTool: true } : { needsTool: false, result };
}

async function main() {
  let baselines;
  try {
    baselines = await loadPublishedBaselines(CRATES);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(2);
  }
  const verdict = registryOnlyVerdict({
    crates: CRATES,
    workspaceVersion: readVersionOrNull(REPO_ROOT),
    latestPublished: (crate) => baselines.get(crate),
  });
  if (verdict.needsTool) {
    console.log('A crate version is ahead of crates.io, so its API has to be compared: run the full gate.');
    process.exit(NEEDS_TOOL_EXIT);
  }
  report(verdict.result);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ Rust crate semver gate failed: ${err.message}`);
    process.exit(2);
  });
}
