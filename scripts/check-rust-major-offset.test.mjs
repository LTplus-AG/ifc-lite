/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Drives the UNMODIFIED gate (`--root <dir>`) over synthetic trees.
 *
 * Every case below is either the gate catching drift, or the gate refusing to
 * report success over something it never examined. The second half is the
 * point: a consistency gate whose scan finds no manifests, no dependency
 * literals or no packages would print the same clean line as a real pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const GATE = join(scriptDir, 'check-rust-major-offset.mjs');
const REPO_ROOT = join(scriptDir, '..');

const MEMBERS = ['core', 'geometry', 'processing', 'clash', 'export', 'ffi', 'wasm-bindings'];

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function rootCargoToml(crateVersion, { depCount = 6 } = {}) {
  const names = ['core', 'geometry', 'processing', 'clash', 'export', 'wasm'].slice(0, depCount);
  const deps = names.map((n) => `ifc-lite-${n} = { version = "${crateVersion}", path = "rust/${n}" }`).join('\n');
  return `[workspace]\nmembers = ["rust/core"]\n\n[workspace.package]\nversion = "${crateVersion}"\nedition = "2021"\n\n[workspace.dependencies]\n${deps}\n`;
}

/**
 * @param {object} opts
 * @param {string} opts.npmVersion highest workspace package version
 * @param {string} opts.crateVersion what the Rust manifests actually carry
 */
function makeTree(t, { npmVersion = '6.0.1', crateVersion = '6.0.1', offsetFile, depCount = 6, memberDeps = true, packageCount = 22 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-rust-major-offset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: npmVersion }));
  mkdirSync(join(root, 'packages'));
  for (let i = 0; i < packageCount; i++) {
    const dir = join(root, 'packages', `p${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `p${i}`, version: i === 0 ? npmVersion : '0.1.0' }));
  }

  writeFileSync(join(root, 'Cargo.toml'), rootCargoToml(crateVersion, { depCount }));
  mkdirSync(join(root, 'rust'));
  for (const member of MEMBERS) {
    mkdirSync(join(root, 'rust', member));
    const dep = memberDeps
      ? `\n[dependencies]\nifc-lite-core = { version = "${crateVersion}", path = "../core" }\n`
      : '\n[dependencies]\n';
    writeFileSync(join(root, 'rust', member, 'Cargo.toml'), `[package]\nname = "ifc-lite-${member}"\nversion.workspace = true\n${dep}`);
  }

  if (offsetFile !== undefined) writeFileSync(join(root, 'rust-major-offset.json'), offsetFile);
  return root;
}

const OFFSET_0 = JSON.stringify({ majorOffset: 0 });
const OFFSET_1 = JSON.stringify({
  majorOffset: 1,
  reason: 'ifc-lite-geometry and ifc-lite-processing carry breaking Rust changes from #3210 under an npm minor bump.',
  refs: ['#3210', '#3216'],
});

test('RED: an offset that nothing has applied to the manifests fails, naming the remedy', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '6.1.0', offsetFile: OFFSET_1 });
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /DRIFT/);
  assert.match(out, /7\.1\.0/);
  assert.match(out, /sync-versions/);
});

test('GREEN: the same offset, applied — npm on 6.1.0, the crates on 7.1.0', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  assert.match(out, /7\.1\.0/);
});

test('GREEN: offset 0 is today — one version across the monorepo', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: OFFSET_0 }));
  assert.equal(code, 0, out);
});

test('a member manifest left behind is caught and named', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'ffi', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-ffi"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { version = "6.1.0", path = "../core" }\n`
  );
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /rust\/ffi\/Cargo\.toml/);
  assert.match(out, /6\.1\.0/);
});

test('an offset one major too low still fails as drift, not as a pass', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '8.1.0', offsetFile: OFFSET_1 });
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /DRIFT/);
});

// ---------------------------------------------------------------------------
// Vacuity: every route to a success line over nothing must be a named failure.
// ---------------------------------------------------------------------------

test('vacuous: no offset file at all', (t) => {
  const { code, out } = run(makeTree(t, {}));
  assert.equal(code, 1);
  assert.match(out, /NO_OFFSET_FILE/);
  assert.match(out, /rust-major-offset\.json/);
});

test('vacuous: an empty offset file', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: '' }));
  assert.equal(code, 1);
  assert.match(out, /BAD_JSON/);
});

test('vacuous: an offset that is not a non-negative integer', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 'one' }) }));
  assert.equal(code, 1);
  assert.match(out, /BAD_OFFSET/);
});

test('vacuous: a major claimed with no reason and no refs', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1 }) }));
  assert.equal(code, 1);
  assert.match(out, /NO_REASON/);
});

test('vacuous: a package scan that found nothing to take a version from', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: OFFSET_0, packageCount: 0 }));
  assert.equal(code, 1);
  assert.match(out, /PACKAGE_FLOOR/);
});

test('vacuous: a version that is not a semver triple', (t) => {
  const { code, out } = run(makeTree(t, { npmVersion: '6.1', crateVersion: '6.1', offsetFile: OFFSET_0 }));
  assert.equal(code, 1);
  assert.match(out, /BAD_VERSION/);
});

test('vacuous: a Cargo.toml with no [workspace.package] version', (t) => {
  const root = makeTree(t, { offsetFile: OFFSET_0 });
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = []\n');
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /NO_WORKSPACE_VERSION/);
});

test('vacuous: no Cargo.toml at all', (t) => {
  const root = makeTree(t, { offsetFile: OFFSET_0 });
  rmSync(join(root, 'Cargo.toml'));
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /NO_CARGO_TOML/);
});

test('vacuous: a workspace dependency table with too few internal literals to be the real one', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: OFFSET_0, depCount: 2 }));
  assert.equal(code, 1);
  assert.match(out, /DEP_FLOOR/);
});

test('vacuous: member manifests that contribute no literals at all', (t) => {
  const { code, out } = run(makeTree(t, { offsetFile: OFFSET_0, memberDeps: false }));
  assert.equal(code, 1);
  assert.match(out, /DEP_FLOOR/);
});

test('a reordered literal is still checked, not counted as absent', (t) => {
  // TOML inline-table key order is free, so `{ path = "…", version = "…" }` is
  // the same declaration as `{ version = "…", path = "…" }`. A pattern that
  // demanded `version` first saw no declaration at all: the gate printed one
  // fewer literal and called the rest agreement, and `sync-versions.js` never
  // rewrote it either. Cargo catches the resulting mismatch, so nothing ships
  // wrong — but a count over a region the scan never examined is the vacuity
  // shape, not a report.
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'clash', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-clash"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { path = "../core", version = "1.2.3" }\n`
  );
  const { code, out } = run(root);
  assert.equal(code, 1, out);
  assert.match(out, /DRIFT/);
  assert.match(out, /rust\/clash\/Cargo\.toml/);
  assert.match(out, /1\.2\.3/);
});

test('a reordered literal that AGREES is counted, so the total stays honest', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'clash', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-clash"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { path = "../core", version = "7.1.0" }\n`
  );
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  // 6 in the root table + one per member manifest, the reordered one included.
  assert.match(out, /13 internal dependency literal\(s\)/);
});

test('a declaration carrying no version requirement is not counted as a literal', (t) => {
  // `{ workspace = true }` pins nothing, so there is nothing to agree with.
  // Counting it would inflate the total the gate reports.
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'clash', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-clash"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { workspace = true }\n`
  );
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  assert.match(out, /12 internal dependency literal\(s\)/);
});

test('vacuous: a declaration the scan cannot parse is named, not skipped', (t) => {
  const root = makeTree(t, { npmVersion: '6.1.0', crateVersion: '7.1.0', offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'clash', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-clash"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { version = "7.1.0", path = "../core", meta = { nested = true } }\n`
  );
  const { code, out } = run(root);
  assert.equal(code, 1, out);
  assert.match(out, /UNPARSED_DEP/);
});

test('vacuous: the crate directory list points nowhere', (t) => {
  const root = makeTree(t, { offsetFile: OFFSET_0 });
  rmSync(join(root, 'rust'), { recursive: true });
  const { code, out } = run(root);
  assert.equal(code, 1);
  assert.match(out, /MISSING_MANIFEST/);
});

// ---------------------------------------------------------------------------
// The real tree. The gate is worthless if it cannot run on this repo.
// ---------------------------------------------------------------------------

test('the real repository passes its own gate', () => {
  const { code, out } = run(REPO_ROOT);
  assert.equal(code, 0, out);
  assert.match(out, /\d+ internal dependency literal/);
});
