/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = process.env.AB_REPORT_CLI ?? fileURLToPath(new URL('./ab-report.mjs', import.meta.url));
// Synthetic software test data only; these values are not performance measurements.
const sample = (side, overrides = {}) => ({
  side,
  path: '/synthetic/test-data/model.ifc',
  parseMs: 10,
  geometryMs: 20,
  totalMs: 35,
  meshes: 2,
  vertices: 12,
  triangles: 4,
  ...overrides,
});

function runReport(rows, extraArgs = []) {
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  return runRawJsonl(jsonl, extraArgs);
}

function runRawJsonl(jsonl, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-report-test-'));
  try {
    const input = join(dir, 'runs.jsonl');
    const output = join(dir, 'report.json');
    writeFileSync(input, jsonl);
    const result = spawnSync(process.execPath, [cli, input, '--json', output, ...extraArgs], { encoding: 'utf8' });
    const outputExists = existsSync(output);
    const outputText = outputExists ? readFileSync(output, 'utf8') : null;
    return {
      ...result,
      outputExists,
      report: outputText === null ? null : JSON.parse(outputText),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRefused(rows, description) {
  assertRefusedResult(runReport(rows), description);
}

function assertRefusedResult(result, description) {
  assert.notEqual(result.status, 0, `${description}: expected nonzero exit; stdout=${result.stdout}`);
  assert.match(`${result.stderr}${result.stdout}`, /ab-report:.*(invalid|missing|must|expected|require|empty|unequal)/i,
    `${description}: expected actionable validation diagnostic; stderr=${result.stderr} stdout=${result.stdout}`);
  assert.equal(result.outputExists, false, `${description}: must not emit success JSON`);
  assert.doesNotMatch(result.stdout, /VERDICT:/, `${description}: must not print a trusted verdict`);
}

test('refuses empty input, unknown sides, and incomplete paired comparisons (#7781)', () => {
  assertRefused([], 'empty JSONL');
  assertRefused([sample('c53'), sample('337')], 'revision names are not row selectors');
  const missingSide = sample('base');
  delete missingSide.side;
  assertRefused([missingSide, sample('branch')], 'missing side field');
  assertRefused([sample('base')], 'missing branch side');
  assertRefused([sample('base'), sample('branch'), sample('base')], 'unequal paired sample counts');
});

test('refuses missing required timings and fingerprint counts (#7781)', () => {
  for (const field of ['parseMs', 'geometryMs', 'totalMs', 'meshes', 'vertices', 'triangles']) {
    const row = sample('base');
    delete row[field];
    assertRefused([row, sample('branch')], `missing ${field}`);
  }
});

test('refuses invalid numeric values rather than silently dropping phases (#7781)', () => {
  for (const [field, value] of [
    ['parseMs', 1e309], ['geometryMs', -1], ['totalMs', '20'], ['entityScanMs', 'invalid'],
    ['meshes', 1.5], ['vertices', -1], ['triangles', 1e309],
  ]) {
    assertRefused([sample('base', { [field]: value }), sample('branch')], `invalid ${field}`);
  }
});

test('refuses raw JSON exponent overflow instead of JSON.stringify converting it to null (#7781)', () => {
  const rawJsonl = [
    '{"side":"base","path":"/synthetic/test-data/model.ifc","parseMs":1e309,"geometryMs":20,"totalMs":35,"meshes":2,"vertices":12,"triangles":4}',
    '{"side":"branch","path":"/synthetic/test-data/model.ifc","parseMs":10,"geometryMs":20,"totalMs":35,"meshes":2,"vertices":12,"triangles":4}',
  ].join('\n') + '\n';
  assertRefusedResult(runRawJsonl(rawJsonl), 'raw JSON parseMs overflow');
});

test('accepts literal sides with custom display labels and retains report behavior', () => {
  const result = runReport([
    sample('base', { parseMs: 10, geometryMs: 20, totalMs: 35, entityScanMs: 2 }),
    sample('branch', { parseMs: 8, geometryMs: 16, totalMs: 28, entityScanMs: 3 }),
  ], ['--base', 'c53', '--branch', '337']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.base, 'c53');
  assert.equal(result.report.branch, '337');
  assert.deepEqual(result.report.fixtures[0].phases.map(({ phase }) => phase), ['parse', 'entity-scan', 'geometry', 'TOTAL']);
  assert.deepEqual(result.report.fixtures[0].fingerprint.meshes, { base: [2], branch: [2] });
  assert.deepEqual(result.report.verdict, { fingerprintDrift: false, tooNoisy: false, realChange: true });
  assert.match(result.stdout, /faster/, 'a real timing delta must retain its existing verdict');
});

test('keeps neutral and output-count-drift verdict behavior on valid one-pair input', () => {
  const neutral = runReport([sample('base'), sample('branch')]);
  assert.equal(neutral.status, 0, neutral.stderr);
  assert.equal(neutral.report.verdict.realChange, false);
  assert.match(neutral.stdout, /within noise/);

  const drift = runReport([sample('base'), sample('branch', { triangles: 5 })]);
  assert.equal(drift.status, 0, drift.stderr);
  assert.equal(drift.report.verdict.fingerprintDrift, true);
  assert.match(drift.stdout, /output fingerprint changed/);
});

test('keeps the base-spread noise verdict on valid repeated pairs', () => {
  const noisy = runReport([
    sample('base', { totalMs: 10 }), sample('branch', { totalMs: 12 }),
    sample('base', { totalMs: 30 }), sample('branch', { totalMs: 31 }),
  ]);
  assert.equal(noisy.status, 0, noisy.stderr);
  assert.equal(noisy.report.verdict.tooNoisy, true);
  assert.match(noisy.stdout, /machine too noisy/);
});
