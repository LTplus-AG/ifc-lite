#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the version the Rust manifests carry is the one the declared major
 * offset says it should be (#3216, item 2).
 *
 * `rust-major-offset.json` is the ONLY place this repo can say "the crates
 * need a major that npm does not". It is applied by `scripts/sync-versions.js`
 * during `pnpm run version`, which runs once per release — so between releases
 * the file and the manifests can disagree with nothing to notice, and the
 * disagreement would first surface as a `cargo publish` at a version that
 * means something other than what the file claims.
 *
 * This recomputes what `sync-versions.js` would write, from the same library
 * that script writes from, and compares it with what is committed:
 *
 *   1. the `[workspace.package] version` in `Cargo.toml`
 *   2. every internal `ifc-lite-* = { version = "…" }` literal in `Cargo.toml`
 *      and in each crate manifest under `rust/`
 *
 * It is the check half of a two-file pair, and both halves import
 * `scripts/lib/rust-major-offset.mjs` — the writer and the checker deriving
 * the expected version separately is the shape that lets a fix land in one and
 * not the other.
 *
 * FAIL-CLOSED, ALWAYS. Every route to a success line over something that was
 * never examined is a named failure, not a pass: `NO_OFFSET_FILE`, `BAD_JSON`,
 * `BAD_OFFSET`, `NO_REASON`, `NO_REFS`, `PACKAGE_FLOOR`, `BAD_VERSION`,
 * `NO_CARGO_TOML`, `NO_WORKSPACE_VERSION`, `MISSING_MANIFEST`, `DEP_FLOOR`,
 * `DRIFT`.
 *
 * WHAT IT DOES NOT COVER, stated rather than left to be discovered:
 *   - Whether the offset is BIG ENOUGH. Nothing here reads a Rust API. That is
 *     `scripts/check-rust-semver.mjs` (#3298), which compares the real public
 *     surface against the crate live on crates.io. This gate only enforces
 *     that whatever offset is declared is the one actually in the manifests.
 *   - A DECREASE of the offset that is also re-synced. Lowering the offset and
 *     re-running `sync-versions.js` is self-consistent, so it passes here; a
 *     crate version going backwards is visible only against the registry,
 *     which is again the semver gate's half.
 *   - `Cargo.lock`. `sync-versions.js` rewrites the members' lock entries, and
 *     drift there is already a hard failure in the `cargo metadata --locked`
 *     step (`scripts/check-generated.mjs`, item 7). Re-checking it here would
 *     be a second opinion on a question that is already answered.
 *   - Anything about the npm packages, whose versions changesets owns.
 *
 * `--root <dir>` points every read at an alternate tree, like
 * `scripts/check-test-wiring.mjs`'s flag of the same name; the regression
 * harness (`scripts/check-rust-major-offset.test.mjs`) drives this unmodified
 * file against synthetic trees, never real repo state.
 *
 * Run via `pnpm check:rust-major-offset`, wired into the CI node-test job.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computeReleaseVersions,
  scanInternalDeps,
  MIN_TOTAL_DEP_LITERALS,
  MIN_WORKSPACE_DEP_LITERALS,
  OFFSET_FILE_NAME,
  RUST_MEMBER_DIRS,
  WORKSPACE_VERSION_PATTERN,
} from './lib/rust-major-offset.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return join(scriptDir, '..');
  const value = argv[i + 1];
  if (!value) {
    console.error('❌ --root needs a directory');
    process.exit(2);
  }
  return value;
}

const rootDir = parseRoot(process.argv.slice(2));
const failures = [];

function fail(code, message) {
  failures.push(`${code}: ${message}`);
}

let versions;
try {
  versions = computeReleaseVersions(rootDir);
} catch (error) {
  console.error(`❌ Rust major-offset gate refused to run (#3216):\n\n  ${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exit(1);
}

const { npmVersion, crateVersion, majorOffset, scanned } = versions;

// 1. The workspace version literal.
const cargoTomlPath = join(rootDir, 'Cargo.toml');
let cargoToml;
try {
  cargoToml = readFileSync(cargoTomlPath, 'utf8');
} catch (error) {
  console.error(`❌ Rust major-offset gate refused to run (#3216):\n\n  NO_CARGO_TOML: could not read ${cargoTomlPath} (${error.message}). This gate exists to compare the Rust manifests with ${OFFSET_FILE_NAME}; with no root manifest there is nothing to compare and a pass would mean nothing.\n`);
  process.exit(1);
}

const workspaceMatch = WORKSPACE_VERSION_PATTERN.exec(cargoToml);
if (!workspaceMatch) {
  console.error(`❌ Rust major-offset gate refused to run (#3216):\n\n  NO_WORKSPACE_VERSION: Cargo.toml has no [workspace.package] version literal. That literal is what every crate publishes at, so its absence is not a clean tree — it is a gate with nothing to check.\n`);
  process.exit(1);
}
if (workspaceMatch[2] !== crateVersion) {
  fail(
    'DRIFT',
    `Cargo.toml [workspace.package] version is ${workspaceMatch[2]}, but npm is at ${npmVersion} and ${OFFSET_FILE_NAME} declares majorOffset ${majorOffset}, which makes the crate version ${crateVersion}.`
  );
}

// 2. Every internal dependency literal, in the root manifest and each member.
let workspaceLiterals = 0;
let totalLiterals = 0;

function checkLiterals(label, text, onCount) {
  let deps;
  try {
    deps = scanInternalDeps(label, text);
  } catch (error) {
    fail(error.code ?? 'UNPARSED_DEP', error.message);
    onCount?.(0);
    return;
  }
  let count = 0;
  for (const dep of deps) {
    // A declaration with no `version` requirement (`{ workspace = true }`, a
    // bare `{ path = "…" }`) pins nothing, so there is nothing to agree with
    // and nothing to count.
    if (dep.version === null) continue;
    count++;
    if (dep.version !== crateVersion) {
      fail('DRIFT', `${label} pins ${dep.name} at ${dep.version}; the crate version for this release is ${crateVersion}.`);
    }
  }
  totalLiterals += count;
  onCount?.(count);
}

checkLiterals('Cargo.toml', cargoToml, (n) => {
  workspaceLiterals = n;
});

for (const member of RUST_MEMBER_DIRS) {
  const memberPath = join(rootDir, 'rust', member, 'Cargo.toml');
  let memberToml;
  try {
    memberToml = readFileSync(memberPath, 'utf8');
  } catch (error) {
    fail(
      'MISSING_MANIFEST',
      `could not read rust/${member}/Cargo.toml (${error.message}). This list of crate directories is hardcoded in scripts/lib/rust-major-offset.mjs, so a rename or a move leaves both the writer and this checker silently skipping a manifest — update RUST_MEMBER_DIRS.`
    );
    continue;
  }
  checkLiterals(`rust/${member}/Cargo.toml`, memberToml);
}

// 3. Floors. A tree where these literals cannot be found is a tree this gate
//    did not actually inspect, whatever the comparisons above concluded.
if (workspaceLiterals < MIN_WORKSPACE_DEP_LITERALS) {
  fail(
    'DEP_FLOOR',
    `found ${workspaceLiterals} internal dependency literal(s) in Cargo.toml's [workspace.dependencies], below the floor of ${MIN_WORKSPACE_DEP_LITERALS}. Either the table shrank or the pattern in scripts/lib/rust-major-offset.mjs stopped matching it; both mean sync-versions.js is no longer rewriting what this gate believes it rewrites.`
  );
}
if (totalLiterals < MIN_TOTAL_DEP_LITERALS) {
  fail(
    'DEP_FLOOR',
    `found ${totalLiterals} internal dependency literal(s) across every manifest, below the floor of ${MIN_TOTAL_DEP_LITERALS}. Refusing to report agreement over a scan this small.`
  );
}

if (failures.length > 0) {
  console.error('❌ Rust major-offset gate failed (#3216):\n');
  for (const line of failures) console.error(`  - ${line}`);
  console.error(
    `\n  Expected crate version: ${crateVersion}  (npm ${npmVersion} + majorOffset ${majorOffset})\n` +
      `  Fix: run \`node scripts/sync-versions.js\` and commit the manifests, or correct "majorOffset" in ${OFFSET_FILE_NAME}.\n` +
      `  Whether that offset is LARGE ENOUGH is a different question, answered by scripts/check-rust-semver.mjs against crates.io.\n`
  );
  process.exit(1);
}

const shape =
  majorOffset === 0
    ? `crates track npm exactly (majorOffset 0)`
    : `crates run ${majorOffset} major(s) ahead of npm ${npmVersion}`;
console.log(
  `✅ Rust crate version ${crateVersion}: ${shape}. ` +
    `${totalLiterals} internal dependency literal(s) across ${RUST_MEMBER_DIRS.length + 1} manifest(s) agree, over ${scanned} workspace package(s) scanned.`
);
