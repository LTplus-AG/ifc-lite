#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The crates.io half of scripts/check-rust-semver.mjs, with no cargo at all.
 *
 * The gate calls cargo-semver-checks only for a crate whose workspace version
 * is ahead of crates.io; every other verdict comes from registry lookups. This
 * runs the gate's own `checkRustSemver` with runners that only record being
 * asked. Nobody asked: the result is the full gate's, printed by its `report`,
 * and on exit 0 this writes `needs_cargo=false` to GITHUB_OUTPUT, the only
 * thing that lets test.yml skip the toolchain and the full gate. Somebody
 * asked: exit NEEDS_TOOL_EXIT and the full gate runs.
 *
 * Run: `node scripts/check-rust-semver-registry.mjs` (test.yml `rust-semver`)
 */

import { appendFileSync } from 'node:fs';
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
  // `report` exits 1 on a refusal, so only a final exit-0 verdict gets here.
  if (!process.env.GITHUB_OUTPUT) return;
  try {
    appendFileSync(process.env.GITHUB_OUTPUT, 'needs_cargo=false\n');
  } catch (err) {
    console.warn(`⚠️ could not write needs_cargo=false (${err.message}); the full gate will run.`);
  }
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ Rust crate semver gate failed: ${err.message}`);
    process.exit(2);
  });
}
