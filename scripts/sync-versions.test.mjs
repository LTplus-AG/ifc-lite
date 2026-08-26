/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * What `scripts/sync-versions.js` WRITES, run rather than reasoned about.
 *
 * `check-rust-major-offset.mjs` and this script are two halves of one rule:
 * the checker says what the manifests must contain, the writer puts it there.
 * Asserting each against its own idea of the answer is exactly how two halves
 * agree on paper and disagree in a release, so the last case here runs the
 * REAL gate over the tree this REAL script just wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SYNC = join(scriptDir, 'sync-versions.js');
const GATE = join(scriptDir, 'check-rust-major-offset.mjs');

const MEMBERS = ['core', 'geometry', 'processing', 'clash', 'export', 'ffi', 'wasm-bindings'];

function run(script, root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, '--root', root], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** A tree standing at the PREVIOUS release (`stale`), with npm already bumped
 * to `npmVersion` by changesets — i.e. what `pnpm run version` sees. */
function makeTree(t, { npmVersion = '6.1.0', stale = '6.0.1', offsetFile, packageBody } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sync-versions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: stale }, null, 2) + '\n');
  mkdirSync(join(root, 'packages'));
  for (let i = 0; i < 22; i++) {
    const dir = join(root, 'packages', `p${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `p${i}`, version: i === 0 ? npmVersion : '0.1.0' }));
  }

  const deps = ['core', 'geometry', 'processing', 'clash', 'export', 'wasm']
    .map((n) => `ifc-lite-${n} = { version = "${stale}", path = "rust/${n}" }`)
    .join('\n');
  const members = MEMBERS.map((m) => `"rust/${m}"`).join(', ');
  writeFileSync(
    join(root, 'Cargo.toml'),
    `[workspace]\nmembers = [${members}]\n\n[workspace.package]\n${packageBody ?? `version = "${stale}"`}\n\n[workspace.dependencies]\n${deps}\n`
  );
  mkdirSync(join(root, 'rust'));
  for (const member of MEMBERS) {
    mkdirSync(join(root, 'rust', member));
    writeFileSync(
      join(root, 'rust', member, 'Cargo.toml'),
      `[package]\nname = "ifc-lite-${member}"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { version = "${stale}", path = "../core" }\n`
    );
  }
  writeFileSync(
    join(root, 'Cargo.lock'),
    MEMBERS.map((m) => `[[package]]\nname = "ifc-lite-${m}"\nversion = "${stale}"\n`).join('\n') +
      `\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`
  );

  if (offsetFile !== undefined) writeFileSync(join(root, 'rust-major-offset.json'), offsetFile);
  return root;
}

const OFFSET_1 = JSON.stringify({
  majorOffset: 1,
  reason: 'ifc-lite-geometry SubMeshCollection and ifc-lite-processing MeshData broke their public API in #3210 under an npm minor.',
  refs: ['#3210'],
});

test('offset 0: the Rust manifests take the npm version, exactly as before', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  const { code } = run(SYNC, root);
  assert.equal(code, 0);
  assert.match(readFileSync(join(root, 'Cargo.toml'), 'utf8'), /\[workspace\.package\]\nversion = "6\.1\.0"/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '6.1.0');
});

test('offset 1 (the #3210 case): npm stays on its minor, the crates go to 7.1.0', (t) => {
  const root = makeTree(t, { offsetFile: OFFSET_1 });
  const { code, out } = run(SYNC, root);
  assert.equal(code, 0, out);

  const cargoToml = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /\[workspace\.package\]\nversion = "7\.1\.0"/);
  assert.equal(cargoToml.includes('6.1.0'), false, 'no npm version may survive in the Rust manifest');
  assert.equal((cargoToml.match(/7\.1\.0/g) ?? []).length, 7, 'workspace version + six internal literals');

  for (const member of MEMBERS) {
    assert.match(readFileSync(join(root, 'rust', member, 'Cargo.toml'), 'utf8'), /version = "7\.1\.0"/, member);
  }

  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  assert.equal((lock.match(/version = "7\.1\.0"/g) ?? []).length, MEMBERS.length);
  assert.match(lock, /name = "serde"\nversion = "1\.0\.0"/, 'a registry crate must not be rewritten');

  // The npm side is untouched by the offset — this is the whole point.
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '6.1.0');
  assert.match(out, /7\.1\.0/);
});

test('the writer and the gate agree over one tree, not just over their own tests', (t) => {
  const root = makeTree(t, { offsetFile: OFFSET_1 });
  assert.equal(run(GATE, root).code, 1, 'before the sync, the manifests are stale and the gate must say so');
  assert.equal(run(SYNC, root).code, 0);
  const after = run(GATE, root);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /7\.1\.0/);
});

test('the writer rewrites a reordered literal too, and both halves see the same tree', (t) => {
  // The writer and the gate share one scan for exactly this reason: while the
  // pattern demanded `version` first, `{ path = "…", version = "…" }` was
  // invisible to BOTH — sync-versions left it on the previous release and the
  // gate counted one fewer literal and called the rest agreement.
  const root = makeTree(t, { offsetFile: OFFSET_1 });
  writeFileSync(
    join(root, 'rust', 'clash', 'Cargo.toml'),
    `[package]\nname = "ifc-lite-clash"\nversion.workspace = true\n\n[dependencies]\nifc-lite-core = { path = "../core", version = "6.0.1" }\n`
  );

  assert.equal(run(SYNC, root).code, 0);

  const clash = readFileSync(join(root, 'rust', 'clash', 'Cargo.toml'), 'utf8');
  assert.match(clash, /ifc-lite-core = \{ path = "\.\.\/core", version = "7\.1\.0" \}/, 'rewritten in place, key order preserved');
  assert.equal(clash.includes('6.0.1'), false, 'the stale literal must not survive');

  const after = run(GATE, root);
  assert.equal(after.code, 0, after.out);
});

test('an array value before the version key does not hide it from the writer', (t) => {
  // TOML permits arrays in `[workspace.package]`. While the section bound
  // rejected the `[` CHARACTER rather than a table HEADER, `authors` declared
  // before `version` made the literal invisible to both halves — and invisible
  // in the worst way: `replace` returned the input, so sync-versions wrote the
  // same bytes back and still logged `✅ Updated Cargo.toml workspace version`,
  // leaving the crates to publish at the previous release.
  const root = makeTree(t, {
    offsetFile: OFFSET_1,
    packageBody: 'authors = ["IFC-Lite Contributors"]\nkeywords = ["ifc", "bim"]\nversion = "6.0.1"\nedition = "2021"',
  });

  const { code, out } = run(SYNC, root);
  assert.equal(code, 0, out);

  const cargoToml = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /^version = "7\.1\.0"$/m, 'the version key itself is rewritten');
  assert.match(cargoToml, /^authors = \["IFC-Lite Contributors"\]$/m, 'the array value is left alone');
  assert.match(cargoToml, /^keywords = \["ifc", "bim"\]$/m);
  assert.match(cargoToml, /^edition = "2021"$/m);
  assert.equal(cargoToml.includes('"6.0.1"'), false, 'no stale literal may survive');

  const after = run(GATE, root);
  assert.equal(after.code, 0, after.out);
});

test('a workspace.package with no version literal stops the release instead of reporting success', (t) => {
  // The refusal that makes the case above safe in general: `replace` cannot
  // tell "rewrote it" from "matched nothing", so the writer checks the pattern
  // rather than trusting the result. The gate refuses on the same condition
  // (NO_WORKSPACE_VERSION); a writer that logged success here would hand the
  // release a manifest still on the previous version.
  const root = makeTree(t, {
    offsetFile: OFFSET_1,
    packageBody: 'edition = "2021"\nrust-version = "1.80"',
  });

  const { code, out } = run(SYNC, root);
  assert.equal(code, 1, `expected a refusal, got:\n${out}`);
  assert.match(out, /NO_WORKSPACE_VERSION/);
  assert.equal(/✅ Updated Cargo\.toml workspace version/.test(out), false, 'it must not claim a successful sync');
});

test('a missing offset file stops the release rather than assuming 0', (t) => {
  const root = makeTree(t, {});
  const { code, out } = run(SYNC, root);
  assert.equal(code, 1);
  assert.match(out, /rust-major-offset\.json/);
});

test('a workspace scan below the floor stops the release rather than syncing to a lower version', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  rmSync(join(root, 'packages'), { recursive: true });
  const { code, out } = run(SYNC, root);
  assert.equal(code, 1);
  assert.match(out, /package\.json file\(s\)/);
  // The manifests must be left where they were, not rewritten to the root
  // package's version off a scan that found nothing.
  assert.match(readFileSync(join(root, 'Cargo.toml'), 'utf8'), /version = "6\.0\.1"/);
});
