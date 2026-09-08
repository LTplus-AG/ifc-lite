/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the pathspec assertion in ci-wasm-prebuilt-eligible.sh
 * (#3200, finding 10).
 *
 * The probe's whole contract is that `false` is always safe and `true` is a
 * claim: the WASM source is byte-identical to the release tag that built the
 * published bundle, so CI may fetch that bundle instead of compiling. The
 * claim rests on `git diff --quiet`, which exits 0 both for "unchanged" and
 * for "your pathspec matched nothing at either end" — so one typo'd entry in
 * WASM_SRC_PATHS made the probe answer `true` over a tree whose Rust source
 * had demonstrably changed.
 *
 * Every case runs the real script against a real (tiny) git repository built
 * here: a tagged commit, then a commit that changes the Rust source. No
 * network — the tag exists locally, so the script's shallow fetch never runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'ci-wasm-prebuilt-eligible.sh');
const TAG = '@ifc-lite/wasm@1.0.0';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * A repository shaped like the one the probe runs in: a wasm package version,
 * every WASM_SRC_PATHS entry present, tagged, then one Rust source edit on top.
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wasm-eligible-'));
  mkdirSync(join(root, 'packages', 'wasm'), { recursive: true });
  mkdirSync(join(root, 'rust'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'packages', 'wasm', 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'rust', 'foo.rs'), 'fn main() {}\n');
  writeFileSync(join(root, 'Cargo.lock'), 'lock v1\n');
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
  writeFileSync(join(root, 'rust-toolchain.toml'), '[toolchain]\n');
  writeFileSync(join(root, 'scripts', 'build-wasm.sh'), 'echo build\n');
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'harness@example.invalid');
  git(root, 'config', 'user.name', 'harness');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'tagged release content');
  git(root, 'tag', TAG);
  return root;
}

function changeRustSource(root) {
  writeFileSync(join(root, 'rust', 'foo.rs'), 'fn main() { println!("changed"); }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change the rust source since the tag');
}

/** Install the gate, optionally with one WASM_SRC_PATHS entry misspelled. */
function installGate(root, { typo = false } = {}) {
  let src = readFileSync(GATE, 'utf-8');
  if (typo) {
    const before = src;
    src = src.replace(/^WASM_SRC_PATHS=\(rust /m, 'WASM_SRC_PATHS=(rustXX ');
    assert.notEqual(src, before, 'the WASM_SRC_PATHS line moved — update this harness');
  }
  writeFileSync(join(root, 'scripts', 'ci-wasm-prebuilt-eligible.sh'), src);
}

function run(root) {
  const res = spawnSync('bash', ['scripts/ci-wasm-prebuilt-eligible.sh'], {
    cwd: root,
    encoding: 'utf-8',
  });
  return { verdict: (res.stdout ?? '').trim(), log: res.stderr ?? '', status: res.status };
}

test('a typo in WASM_SRC_PATHS cannot buy a `true` over changed Rust source', () => {
  const root = makeRepo();
  changeRustSource(root);
  installGate(root, { typo: true });
  const { verdict, log } = run(root);
  // Was: `🅰 WASM source identical to … — prebuilt npm bundle is valid.` and
  // `true`, because the misspelled pathspec matched nothing at either end and
  // `git diff --quiet` reports that as no difference.
  assert.equal(verdict, 'false', log);
  assert.match(log, /entry 'rustXX' matches no file at/);
  assert.doesNotMatch(log, /prebuilt npm bundle is valid/);
  rmSync(root, { recursive: true, force: true });
});

test('a typo is refused even when the sources really are unchanged', () => {
  const root = makeRepo();
  installGate(root, { typo: true });
  const { verdict, log } = run(root);
  // The answer would have been `true` legitimately here. It is still refused,
  // because a list that cannot compare what it names has stopped being
  // evidence — and `false` only ever costs a from-source build.
  assert.equal(verdict, 'false', log);
  assert.match(log, /entry 'rustXX' matches no file at/);
  rmSync(root, { recursive: true, force: true });
});

test('positive control: the fast path still answers `true` on an unchanged tree', () => {
  const root = makeRepo();
  installGate(root);
  const { verdict, log } = run(root);
  assert.equal(verdict, 'true', log);
  assert.match(log, /prebuilt npm bundle is valid/);
  rmSync(root, { recursive: true, force: true });
});

test('negative control: a real Rust change still answers `false`, naming the file', () => {
  const root = makeRepo();
  changeRustSource(root);
  installGate(root);
  const { verdict, log } = run(root);
  assert.equal(verdict, 'false', log);
  assert.match(log, /Rust sources changed since/);
  assert.match(log, /changed: rust\/foo\.rs/);
  rmSync(root, { recursive: true, force: true });
});

test('a path deleted since the tag still counts as named, and still diffs', () => {
  const root = makeRepo();
  // rust-toolchain.toml exists at the tag and not at HEAD: it matches at one
  // end, which is what the assertion requires, and the deletion is a real
  // difference the probe must report.
  rmSync(join(root, 'rust-toolchain.toml'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'delete rust-toolchain.toml');
  installGate(root);
  const { verdict, log } = run(root);
  assert.equal(verdict, 'false', log);
  assert.doesNotMatch(log, /matches no file at/);
  assert.match(log, /changed: rust-toolchain\.toml/);
  rmSync(root, { recursive: true, force: true });
});

test('every WASM_SRC_PATHS entry in the shipped script names something in this repo', () => {
  // The assertion above only fires in CI once the list is already wrong. This
  // catches the same typo at review time, against the real checkout.
  const src = readFileSync(GATE, 'utf-8');
  const line = src.match(/^WASM_SRC_PATHS=\((.*)\)$/m);
  assert.ok(line, 'WASM_SRC_PATHS is no longer a single-line array — update this harness');
  const entries = line[1].split(/\s+/).filter(Boolean);
  assert.ok(entries.length >= 5, `expected at least 5 source paths, got ${entries.length}`);
  const repoRoot = join(HERE, '..');
  for (const entry of entries) {
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', entry], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    assert.ok(listed.trim().length > 0, `WASM_SRC_PATHS entry '${entry}' matches no tracked file`);
  }
});
