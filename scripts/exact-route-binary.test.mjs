/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSavedBinary, saveCompiledBinary } from './exact-route-binary.mjs';
import { sha256 } from './exact-route-source.mjs';
import { cohort } from './lib/exact-route-cohort.mjs';
const setup = t => { const root = mkdtempSync(join(tmpdir(), 'capture-binary-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
test('executes the saved compiled bytes after original shared-target replacement', t => {
  const root = setup(t), compiled = join(root, 'shared'), saved = join(root, 'capture-binary');
  writeFileSync(compiled, `#!${process.execPath}\nconsole.log('original compiled fixture');\n`); chmodSync(compiled, 0o700);
  const expected = sha256(readFileSync(compiled)), binary = saveCompiledBinary(compiled, saved, expected);
  writeFileSync(compiled, `#!${process.execPath}\nconsole.log('replaced shared target');\n`);
  const result = executeSavedBinary(binary, [], root);
  assert.equal(result.execution.status, 0); assert.equal(result.execution.stdout.trim(), 'original compiled fixture');
  assert.equal(result.provenance.afterSha256, expected);
});
test('replacement before snapshot refuses despite a valid executable path', t => {
  const root = setup(t), compiled = join(root, 'shared'); writeFileSync(compiled, 'replacement');
  assert.throws(() => saveCompiledBinary(compiled, join(root, 'capture-binary'), sha256('original')));
});
test('saved-copy mutation during execution refuses post-capture validation', t => {
  const root = setup(t), compiled = join(root, 'shared'), saved = join(root, 'capture-binary');
  writeFileSync(compiled, `#!${process.execPath}\nconst fs=require('node:fs');fs.chmodSync(process.argv[1],0o700);fs.writeFileSync(process.argv[1],'mutated');\n`);
  chmodSync(compiled, 0o700); const binary = saveCompiledBinary(compiled, saved, sha256(readFileSync(compiled)));
  assert.throws(() => executeSavedBinary(binary, [], root), /terminal compiled artifact/);
});
test('replaced saved binary with rebound receipt hash and fleet marker still refuses unchanged compiler trace', t => {
  const c = cohort(t), path = join(c.dirs[1], 'capture-binary'); writeFileSync(path, 'different executable');
  c.alter(r => { r.binary.sha256 = sha256(readFileSync(path));
    r.fixtures[0].execution.beforeSha256 = r.binary.sha256; r.fixtures[0].execution.afterSha256 = r.binary.sha256; });
  assert.throws(c.compare, /terminal compiled executable/);
});
