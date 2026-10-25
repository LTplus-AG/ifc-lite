/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// #8042: exercise the generator's CLI and filesystem contract. The small
// engine fixture controls drift; Rust's parity tests verify the actual hashes.
test('parity --check detects engine/corpus drift without rewriting expectations (#8042)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'diff-parity-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'packages/diff/dist', 'rust/diff/tests']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  copyFileSync(new URL('./diff-parity-vectors.mjs', import.meta.url), join(root, 'scripts/diff-parity-vectors.mjs'));
  const engine = join(root, 'packages/diff/dist/fingerprint.js');
  const installEngine = (hash) => writeFileSync(engine, `
    export const stableHash = () => '${hash}';
    export const buildDataFingerprint = () => '${hash}';
    export const buildComponentFingerprints = () => ({ 'attr:core': '${hash}' });
  `);
  installEngine('initial');
  const run = (...args) => spawnSync(process.execPath, ['scripts/diff-parity-vectors.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  const generated = run();
  assert.equal(generated.status, 0, generated.stderr);
  const corpus = join(root, 'rust/diff/tests/fingerprint_vectors.json');
  const original = readFileSync(corpus, 'utf8');
  assert.equal(run('--check').status, 0);

  installEngine('changed');
  const drift = run('--check');
  assert.equal(drift.status, 1, drift.stderr);
  assert.match(drift.stderr, /differ from the built TypeScript engine/);
  assert.equal(readFileSync(corpus, 'utf8'), original, 'check must preserve the committed oracle');

  installEngine('initial');
  writeFileSync(corpus, '{}\n');
  assert.equal(run('--check').status, 1, 'a stale corpus must also fail');
  assert.equal(readFileSync(corpus, 'utf8'), '{}\n');
});
