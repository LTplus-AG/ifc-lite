/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { corpusFindings, corpusProblems } from './check-retained-corpus-summary.mjs';

const ok = { complete: true, violations: [], universeMismatch: [], skipped: [] };

test('a complete, empty summary passes', () => assert.deepEqual(corpusProblems(ok), []));

test('violations, universe mismatches and absent fixtures each fail by name', () => {
  assert.match(corpusProblems({ ...ok, violations: ['m:1 bad'] }).join(), /PARITY: violations has 1 entry: m:1 bad/);
  assert.match(corpusProblems({ ...ok, universeMismatch: ['a', 'b'] }).join(), /universeMismatch has 2 entries/);
  assert.match(corpusProblems({ ...ok, skipped: ['x.ifc: absent; run pnpm fixtures'] }).join(), /skipped has 1 entry/);
});

test('an incomplete or malformed summary fails closed', () => {
  assert.match(corpusProblems({ ...ok, complete: false }).join(), /INCOMPLETE: the run is not marked complete/);
  assert.match(corpusProblems({ complete: true }).join(), /violations is missing/);
  assert.match(corpusProblems([]).join(), /INCOMPLETE: summary.json is not an object/);
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

test('the CLI requires exactly the expected number of shard summaries and names the failing one', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-summary-shards-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(import.meta.dirname, 'check-retained-corpus-summary.mjs');
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  writeFileSync(a, JSON.stringify(ok));
  writeFileSync(b, JSON.stringify({ ...ok, complete: false }));
  execFileSync(process.execPath, [script, '--shards', '1', a]);
  assert.equal(spawnSync(process.execPath, [script, '--shards', '2', a]).status, 1);
  const bad = spawnSync(process.execPath, [script, '--shards', '2', a, b], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /b\.json: INCOMPLETE/);
});

test('report-violations downgrades only violations; incomplete, mismatch and skipped still fail', () => {
  const opts = { reportViolations: true };
  assert.deepEqual(corpusFindings({ ...ok, violations: ['v'] }, opts).problems, []);
  assert.match(corpusFindings({ ...ok, violations: ['v'] }, opts).warnings.join(), /PARITY: violations has 1 entry/);
  assert.match(corpusProblems({ ...ok, complete: false, violations: ['v'] }, opts).join(), /INCOMPLETE/);
  assert.match(corpusProblems({ ...ok, universeMismatch: ['u'] }, opts).join(), /universeMismatch/);
  assert.match(corpusProblems({ ...ok, skipped: ['s'] }, opts).join(), /skipped/);
  assert.match(corpusProblems({ ...ok, violations: ['v'] }).join(), /PARITY: violations/);
});

test('the CLI flag makes a complete run with violations pass with a warning, an incomplete one still fails', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-summary-report-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(import.meta.dirname, 'check-retained-corpus-summary.mjs');
  const v = join(dir, 'v.json');
  const i = join(dir, 'i.json');
  writeFileSync(v, JSON.stringify({ ...ok, violations: ['x'] }));
  writeFileSync(i, JSON.stringify({ ...ok, complete: false, violations: ['x'] }));
  const pass = spawnSync(process.execPath, [script, '--report-violations', v], { encoding: 'utf8' });
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /::warning title=native corpus parity \(report only\)::/);
  assert.equal(spawnSync(process.execPath, [script, '--report-violations', i]).status, 1);
  assert.equal(spawnSync(process.execPath, [script, v]).status, 1);
});

test('each failure class names a remedy that matches its finding', () => {
  assert.match(corpusProblems({ ...ok, complete: false }).join(), /INCOMPLETE.*re-run the failed shard/);
  assert.match(corpusProblems({ ...ok, universeMismatch: ['m'] }).join(), /exact and retained product sets differ/);
  assert.match(corpusProblems({ ...ok, skipped: ['m'] }).join(), /pnpm fixtures/);
  assert.match(corpusProblems({ ...ok, violations: ['m'] }).join(), /products\.tsv/);
  assert.match(corpusProblems({ complete: true }).join(), /truncated or from a different tool version/);
});
