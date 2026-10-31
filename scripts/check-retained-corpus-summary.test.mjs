/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { corpusProblems } from './check-retained-corpus-summary.mjs';

const ok = { complete: true, violations: [], universeMismatch: [], skipped: [] };

test('a complete, empty summary passes', () => assert.deepEqual(corpusProblems(ok), []));

test('violations, universe mismatches and absent fixtures each fail by name', () => {
  assert.match(corpusProblems({ ...ok, violations: ['m:1 bad'] }).join(), /violations has 1 entry: m:1 bad/);
  assert.match(corpusProblems({ ...ok, universeMismatch: ['a', 'b'] }).join(), /universeMismatch has 2 entries/);
  assert.match(corpusProblems({ ...ok, skipped: ['x.ifc: absent; run pnpm fixtures'] }).join(), /skipped has 1 entry/);
});

test('an incomplete or malformed summary fails closed', () => {
  assert.match(corpusProblems({ ...ok, complete: false }).join(), /not marked complete/);
  assert.match(corpusProblems({ complete: true }).join(), /violations is missing/);
  assert.match(corpusProblems([]).join(), /not an object/);
});

test('the CLI exits non-zero on a failing summary and on an unreadable one', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-summary-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(import.meta.dirname, 'check-retained-corpus-summary.mjs');
  writeFileSync(join(dir, 'good.json'), JSON.stringify(ok));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...ok, violations: ['x'] }));
  execFileSync(process.execPath, [script, join(dir, 'good.json')]);
  assert.equal(spawnSync(process.execPath, [script, join(dir, 'bad.json')]).status, 1);
  assert.equal(spawnSync(process.execPath, [script, join(dir, 'missing.json')]).status, 1);
});
