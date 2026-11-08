#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the modelling-parity scorecard (#9296):
 * `tests/modelling-parity/score.mjs` (scoring rules and the ratchet) and
 * `scripts/generate-modelling-parity-ledger.mjs` (the committed ledger is
 * current; a changed summary changes it; vacuous or mismatched inputs fail).
 *
 * Run: node --test scripts/generate-modelling-parity-ledger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const GENERATOR = join(SCRIPTS, 'generate-modelling-parity-ledger.mjs');
const SCORE = join(ROOT, 'tests/modelling-parity/score.mjs');
const { score, ratchet, readResults } = await import(pathToFileURL(SCORE).href);

const result = (capability, probe, status, extra = {}) => ({
  schema: 'ifclite-parity-result/1', capability, probe, id: `${probe}.${capability}.${status}`, status,
  ...(status === 'pass' ? {} : { reason: `${probe} ${status}` }), metrics: {}, evidence: [],
  source: { commit: 'abc123', dirty: false }, runner: 'test', ...extra,
});
const all = { sdk: { applicable: true }, ui: { applicable: true }, output: { applicable: true } };
const CATALOGUE = {
  capabilities: [
    { id: 'a', title: 'A', group: 'G', tableStakes: true, probes: all },
    { id: 'b', title: 'B', group: 'G', tableStakes: true, probes: { sdk: { applicable: false }, ui: { applicable: true }, output: { applicable: false } } },
    { id: 'd', title: 'D', group: 'G', tableStakes: true, probes: all },
    { id: 'e', title: 'E', group: 'G', tableStakes: true, probes: all },
    { id: 'x', title: 'X', group: 'Extra', tableStakes: false, probes: all },
  ],
};
const RESULTS = [
  result('a', 'sdk', 'fail'), result('a', 'sdk', 'pass'), result('a', 'ui', 'pass'), result('a', 'output', 'pass'),
  result('b', 'sdk', 'skip'), result('b', 'ui', 'pass'),
  result('d', 'sdk', 'skip'), result('d', 'ui', 'skip'), result('d', 'output', 'skip'),
  result('e', 'sdk', 'partial'), result('e', 'output', 'fail'), result('e', 'exercise', 'pass'),
  result('x', 'sdk', 'pass'),
];

test('score: best status per level, met/partial/missing, skip never passes, extras not scored', () => {
  const s = score(CATALOGUE, RESULTS, { generatedAt: 't' });
  const row = (id) => s.rows.find((r) => r.capability === id);
  assert.equal(row('a').levels.sdk.status, 'pass', 'best of fail and pass is pass');
  assert.equal(row('a').status, 'met');
  assert.equal(row('b').status, 'met', 'only applicable levels must pass');
  assert.equal(row('d').status, 'missing', 'skip on every level is missing, not met');
  assert.equal(row('e').status, 'partial');
  assert.equal(row('e').levels.ui.status, 'none');
  assert.equal(row('e').levels.exercise.status, 'pass', 'exercise is reported');
  assert.equal(row('x').status, 'partial');
  assert.deepEqual(s.counts, { met: 2, partial: 1, missing: 1 });
  assert.equal(s.score, 2.5);
  assert.equal(s.maxScore, 4, 'only table-stakes rows count');
});

test('score: a met row needs a pass on every applicable level, not just one', () => {
  const s = score(CATALOGUE, [result('a', 'sdk', 'pass'), result('a', 'output', 'pass')]);
  assert.equal(s.rows.find((r) => r.capability === 'a').status, 'partial', 'ui never ran');
});

test('score: results for unknown capabilities are flagged', () => {
  const s = score(CATALOGUE, [...RESULTS, result('nope', 'sdk', 'pass')]);
  assert.deepEqual(s.unknownCapabilities, ['nope']);
});

test('ratchet: equal or better passes; a row or score drop fails', () => {
  const base = score(CATALOGUE, RESULTS);
  assert.deepEqual(ratchet(base, base), []);
  assert.deepEqual(ratchet(base, score(CATALOGUE, [...RESULTS, result('e', 'ui', 'pass')])), []);
  const worse = score(CATALOGUE, RESULTS.filter((r) => !(r.capability === 'e' && r.probe === 'sdk')));
  const problems = ratchet(base, worse);
  assert.ok(problems.some((p) => p.includes('score dropped from 2.5 to 2')), problems.join('; ')); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  assert.ok(problems.some((p) => p === 'e: partial -> missing'), problems.join('; '));
});

test('score.mjs CLI: reads arrays and JSON lines, --check exits 1 on a drop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-score-'));
  try {
    const cat = join(dir, 'catalogue.json');
    writeFileSync(cat, JSON.stringify(CATALOGUE));
    mkdirSync(join(dir, 'res', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'res', 'array.json'), JSON.stringify(RESULTS.slice(0, 6)));
    writeFileSync(join(dir, 'res', 'nested', 'lines.jsonl'), RESULTS.slice(6).map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'res', 'noise.json'), JSON.stringify({ schema: 'something-else/1', capability: 'a', probe: 'ui', status: 'fail' }));
    assert.equal(readResults([join(dir, 'res')]).length, RESULTS.length);
    const run = (...args) => spawnSync(process.execPath, [SCORE, join(dir, 'res'), '--catalogue', cat, '--quiet', ...args], { encoding: 'utf8' });
    const first = run('--out', join(dir, 'base.json'));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')).score, 2.5);
    assert.equal(run('--out', join(dir, 'same.json'), '--check', join(dir, 'base.json')).status, 0);
    rmSync(join(dir, 'res', 'nested'), { recursive: true });
    const dropped = run('--out', join(dir, 'worse.json'), '--check', join(dir, 'base.json'));
    assert.equal(dropped.status, 1, 'losing results must fail the ratchet');
    assert.match(dropped.stderr, /Ratchet FAILED/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp tree with the real catalogue and the given summaries under baseline/. */
function tree(summaries) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-ledger-'));
  mkdirSync(join(dir, 'tests/modelling-parity/baseline'), { recursive: true });
  writeFileSync(join(dir, 'tests/modelling-parity/catalogue.json'), readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json')));
  for (const [name, body] of Object.entries(summaries)) writeFileSync(join(dir, 'tests/modelling-parity/baseline', name), JSON.stringify(body));
  return dir;
}
const generate = (root, ...args) => spawnSync(process.execPath, [GENERATOR, '--root', root, ...args], { encoding: 'utf8' });
const realCatalogue = JSON.parse(readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json'), 'utf8'));
const summaryOf = (results, generatedAt) => score(realCatalogue, results, { generatedAt });

test('the committed ledger matches the newest committed baseline summary', () => {
  const r = spawnSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('ledger: renders the newest summary, and a different summary changes the ledger', () => {
  const older = summaryOf([result('storeys', 'sdk', 'pass')], '2026-01-01T00:00:00.000Z');
  const newer = summaryOf([result('storeys', 'sdk', 'pass'), result('storeys', 'ui', 'pass'), result('storeys', 'output', 'pass'), result('grids', 'sdk', 'partial')], '2026-02-01T00:00:00.000Z');
  const dir = tree({ 'a-new.json': newer, 'z-old.json': older });
  try {
    assert.equal(generate(dir).status, 0);
    const ledger = readFileSync(join(dir, 'docs/architecture/modelling-parity-ledger.md'), 'utf8');
    assert.match(ledger, /\*\*Table-stakes score: 1\.5 \/ 25\*\*/, 'newest generatedAt wins, not the last file name'); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    assert.match(ledger, /\| Storeys and levels \(`storeys`\) \| Levels and grids \| ✅ \| ✅ \| ✅ \| – \| ✅ met \|/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    assert.match(ledger, /`grids`.*◐ partial.*\*\*sdk\*\* partial: sdk partial/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    writeFileSync(join(dir, 'tests/modelling-parity/baseline/a-new.json'), JSON.stringify({ ...newer, score: 2 }));
    const stale = generate(dir, '--check');
    assert.equal(stale.status, 1, 'a changed summary must make --check fail');
    assert.match(stale.stderr, /is stale/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: refuses vacuous or mismatched summaries', () => {
  const good = summaryOf([result('storeys', 'sdk', 'pass')], '2026-01-01T00:00:00.000Z');
  for (const [label, body, message] of [
    ['no rows', { ...good, rows: [] }, /no rows/],
    ['unknown row', { ...good, rows: [...good.rows, { ...good.rows[0], capability: 'not-a-capability' }] }, /does not know: not-a-capability/],
    ['missing table-stakes row', { ...good, rows: good.rows.filter((r) => r.capability !== 'grids') }, /lacks table-stakes rows: grids/],
  ]) {
    const dir = tree({ 'r.json': body });
    try {
      const r = generate(dir);
      assert.equal(r.status, 1, `${label} must fail`);
      assert.match(r.stderr, message, label); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const empty = tree({});
  try {
    assert.equal(generate(empty).status, 1, 'no summary at all must fail');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
