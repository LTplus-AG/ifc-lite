#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: the crate-root-reachable public Rust API of every published crate
 * (`scripts/lib/crates-io.mjs`'s `CRATES`) is snapshotted in
 * `scripts/rust-api-surface.json`. #4178 added `pub triangle_count: usize`
 * to `OpeningDiagnostic` — a `pub` struct re-exported at the
 * `ifc-lite-geometry` crate root, every field `pub`, no `#[non_exhaustive]`
 * — and nothing said this needed a major until the RELEASE PR
 * (`scripts/check-rust-semver.mjs`, issue #3216), by which point the field
 * had to be reverted to unblock the release rather than choosing the bump
 * up front (issue #4192).
 *
 * This is the SAME signal `scripts/check-api-surface.mjs` gives the
 * TypeScript side, in the same shape: a committed snapshot, diffed on every
 * PR, no build. See `scripts/lib/rust-public-api.mjs` for what is and is not
 * tracked, and why.
 *
 * WHAT THIS DOES NOT REPLACE: `scripts/check-rust-semver.mjs` still runs
 * `cargo-semver-checks` against the crates.io baseline at release time and
 * catches everything a real build can see (signature/arity changes, lost
 * trait impls, defaultless trait methods, …) that a text parse cannot. This
 * gate exists to move ONE class of that gate's findings — a field or
 * variant added to a non-`#[non_exhaustive]` struct/enum — from "the release
 * PR, too late to choose cheaply" to "the PR that added it".
 *
 * Modes:
 *   node scripts/check-rust-api-surface.mjs            # check (CI)
 *   node scripts/check-rust-api-surface.mjs --update   # rewrite the snapshot
 *
 * Run via `pnpm check:rust-api-surface` / `pnpm rust-api-surface:update`.
 *
 * VACUITY. Every way this gate could report success over nothing is an
 * explicit failure with a named reason: fewer crates discovered than the
 * published list, a crate whose `lib.rs` yields zero `pub use`/`pub` items,
 * or an ambiguous struct/enum name silently resolved instead of flagged.
 * None of those reads as a pass.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRATES } from './lib/crates-io.mjs';
import { extractCrateSurface, discoverCrateDirs } from './lib/rust-public-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUST_ROOT = join(ROOT, 'rust');
const SNAPSHOT_PATH = join(ROOT, 'scripts', 'rust-api-surface.json');
const UPDATE = process.argv.includes('--update');

/**
 * Floor on the crate count, mirroring `check-rust-semver.mjs`'s
 * `CRATE_FLOOR`: importing `CRATES` rather than re-typing it rules out one
 * drift, not all of them — a `discoverCrateDirs` bug that silently found
 * fewer directories would otherwise print the same success line as a run
 * that covered every crate.
 */
export const CRATE_FLOOR = 7;

/**
 * Build the full snapshot, or throw a named, actionable error.
 * @returns {{ snapshot: Record<string, Record<string,string>>, warnings: string[] }}
 */
export function buildSnapshot({ crates = CRATES, rustRoot = RUST_ROOT } = {}) {
  if (!crates || crates.length === 0) {
    throw new Error(
      'NO_CRATES: the crate list is empty, so this gate would have checked nothing. ' +
        'It reads CRATES from scripts/lib/crates-io.mjs; if that moved, follow it.'
    );
  }
  if (crates.length < CRATE_FLOOR) {
    throw new Error(
      `CRATE_FLOOR: found ${crates.length} crate(s), fewer than the floor of ${CRATE_FLOOR}. ` +
        'The scan is wrong, not the workspace — if a crate was genuinely dropped from the ' +
        'publish list, lower CRATE_FLOOR in the same commit.'
    );
  }

  const dirs = discoverCrateDirs(rustRoot, crates);
  const missing = crates.filter((c) => !dirs.has(c));
  if (missing.length > 0) {
    throw new Error(
      `MISSING_CRATE_DIR: no rust/*/Cargo.toml declares name = "${missing[0]}"` +
        (missing.length > 1 ? ` (and ${missing.length - 1} more)` : '') +
        '. Every published crate must resolve to a directory.'
    );
  }

  const snapshot = {};
  const warnings = [];
  for (const crate of crates) {
    const { surface, warnings: crateWarnings, pubUseCount } = extractCrateSurface(dirs.get(crate));
    if (Object.keys(surface).length === 0) {
      throw new Error(`EMPTY_SURFACE: ${crate} yielded zero crate-root-reachable public items`);
    }
    for (const w of crateWarnings) warnings.push(`${crate}: ${w}`);
    snapshot[crate] = surface;
    void pubUseCount;
  }
  return { snapshot, warnings };
}

export function diffCrate(before = {}, after = {}) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const removed = [];
  const added = [];
  const changed = [];
  for (const name of names) {
    if (!(name in after)) removed.push(`${name}: ${before[name]}`);
    else if (!(name in before)) added.push(`${name}: ${after[name]}`);
    else if (before[name] !== after[name]) changed.push({ name, before: before[name], after: after[name] });
  }
  return { removed, added, changed };
}

function main() {
  let snapshot;
  let warnings;
  try {
    ({ snapshot, warnings } = buildSnapshot());
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.error('⚠️  Ambiguous names — resolved to "ambiguous" rather than guessed:\n');
    for (const w of warnings) console.error(`   ${w}`);
    console.error('');
  }

  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (UPDATE) {
    writeFileSync(SNAPSHOT_PATH, serialized);
    const total = Object.values(snapshot).reduce((n, s) => n + Object.keys(s).length, 0);
    console.log(
      `✅ Wrote scripts/rust-api-surface.json (${Object.keys(snapshot).length} crates, ${total} tracked items).`
    );
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    console.error('❌ scripts/rust-api-surface.json is missing. Run `pnpm rust-api-surface:update` and commit it.');
    process.exit(1);
  }

  const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const crateNames = [...new Set([...Object.keys(committed), ...Object.keys(snapshot)])].sort();
  let dirty = false;

  for (const crate of crateNames) {
    if (!(crate in snapshot)) {
      dirty = true;
      console.error(`\n${crate}: no longer published (in snapshot, not in scripts/lib/crates-io.mjs CRATES)`);
      continue;
    }
    if (!(crate in committed)) {
      dirty = true;
      console.error(`\n${crate}: newly published crate (not in snapshot)`);
      for (const [name, detail] of Object.entries(snapshot[crate]).sort()) {
        console.error(`   + ${name}: ${detail}`);
      }
      continue;
    }
    const { removed, added, changed } = diffCrate(committed[crate], snapshot[crate]);
    if (removed.length === 0 && added.length === 0 && changed.length === 0) continue;
    dirty = true;
    console.error(`\n${crate}:`);
    for (const e of removed) console.error(`   - ${e}`);
    for (const e of added) console.error(`   + ${e}`);
    for (const c of changed) {
      console.error(`   ~ ${c.name}:`);
      console.error(`       - ${c.before}`);
      console.error(`       + ${c.after}`);
    }
  }

  if (dirty) {
    console.error(`
❌ Rust public API surface drifted from scripts/rust-api-surface.json (see diff above).

A field/variant ADDED to a non-#[non_exhaustive] struct or enum shown above is a
struct-literal- or match-breaking change for any external caller — the same class
of break that forced #4178's field to be reverted after cargo-semver-checks caught
it at release time (issue #4192). Decide BEFORE merging, not at release:

  - If this is safe (the type is not really constructed/matched externally, or the
    bump is deliberately a major): run \`pnpm rust-api-surface:update\`, commit the
    snapshot, and raise the crate's version by hand or via changeset as appropriate.
  - If it is NOT intentional, restore the previous shape or add
    \`#[non_exhaustive]\` to the type instead of adding to it directly.

This gate does not itself decide the bump — it only makes the choice visible where
it is still cheap. \`pnpm check:rust-semver\` remains the release-time authority.`);
    process.exit(1);
  }

  const total = Object.values(snapshot).reduce((n, s) => n + Object.keys(s).length, 0);
  console.log(
    `✅ Rust public API surface matches snapshot (${Object.keys(snapshot).length} crates, ${total} tracked items).`
  );
}

if (process.argv[1] && process.argv[1].endsWith('check-rust-api-surface.mjs')) main();
