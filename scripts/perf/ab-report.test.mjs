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
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
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
    ['parseMs', Number.POSITIVE_INFINITY], ['geometryMs', -1], ['totalMs', '20'], ['entityScanMs', 'invalid'],
    ['meshes', 1.5], ['vertices', -1], ['triangles', Number.POSITIVE_INFINITY],
  ]) {
    assertRefused([sample('base', { [field]: value }), sample('branch')], `invalid ${field}`);
  }
});

test('refuses raw JSON exponent overflow instead of JSON.stringify converting it to null (#7781)', () => {
  for (const field of ['parseMs', 'triangles']) {
    const overflow = JSON.stringify(sample('base', { [field]: 'overflow' })).replace('"overflow"', '1e309');
    const rawJsonl = overflow + '\n' + JSON.stringify(sample('branch')) + '\n';
    assertRefusedResult(runRawJsonl(rawJsonl), `raw JSON ${field} overflow`);
  }
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
  assert.deepEqual(result.report.verdict, { fingerprintDrift: false, tooNoisy: false, realChange: true,
    inconclusive: false, zeroBaselineIncrease: false });
  const parse = result.report.fixtures[0].phases.find(({ phase }) => phase === 'parse');
  assert.deepEqual(parse, { phase: 'parse', baseMedianMs: 10, branchMedianMs: 8,
    deltaPct: -20, noisePct: 0, real: true, direction: 'faster' });
  const scan = result.report.fixtures[0].phases.find(({ phase }) => phase === 'entity-scan');
  assert.equal(scan.deltaPct, 50);
  assert.equal(scan.direction, 'slower');
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(result.stdout, /parse\s+10\.0\s+8\.0\s+-20\.0%\s+±0%\s+✅/,
    'the speedup phase itself must be tagged faster');
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(result.stdout, /entity-scan\s+2\.0\s+3\.0\s+\+50\.0%\s+±0%\s+⛔/,
    'the slower phase itself must be tagged slower');
});

test('zero baselines cannot produce a trusted within-noise verdict (#7912)', () => {
  const phases = { parseMs: 'parse', entityScanMs: 'entity-scan', lookupMs: 'lookup/styles',
    preprocessMs: 'preprocess', geometryMs: 'geometry', totalMs: 'TOTAL' };
  for (const [key, phase] of Object.entries(phases)) {
    for (const branch of [0, 10]) {
      const result = runReport([sample('base', { [key]: 0 }), sample('branch', { [key]: branch })]);
      assert.equal(result.status, 0, result.stderr);
      const row = result.report.fixtures[0].phases.find((p) => p.phase === phase);
      assert.deepEqual(row, { phase, baseMedianMs: 0, branchMedianMs: branch,
        deltaPct: null, noisePct: null, real: false, direction: null });
      assert.equal(result.report.verdict.inconclusive, branch === 0);
      assert.equal(result.report.verdict.zeroBaselineIncrease, branch > 0);
      assert.doesNotMatch(result.stdout, /within noise|Not a measurable change/);
      // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
      assert.match(result.stdout, branch === 0 ? /VERDICT:.*inconclusive/ : /VERDICT:.*blocked/);
    }
  }
});

test('positive baselines retain a finite speedup when the branch reaches zero (#7912)', () => {
  const result = runReport([sample('base'), sample('branch', { parseMs: 0 })]);
  assert.equal(result.status, 0, result.stderr);
  const parse = result.report.fixtures[0].phases.find(({ phase }) => phase === 'parse');
  assert.deepEqual(parse, { phase: 'parse', baseMedianMs: 10, branchMedianMs: 0,
    deltaPct: -100, noisePct: 0, real: true, direction: 'faster' });
  assert.equal(result.report.verdict.inconclusive, false);
  assert.equal(result.report.verdict.zeroBaselineIncrease, false);
});

test('other phase movements cannot offset an inconclusive zero baseline (#7912)', () => {
  const result = runReport([sample('base', { lookupMs: 0 }),
    sample('branch', { lookupMs: 0, parseMs: 8 })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.verdict.realChange, true);
  assert.equal(result.report.verdict.inconclusive, true);
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(result.stdout, /VERDICT:.*inconclusive/);
});

test('zero-baseline increases stay blocked while noisy TOTAL remains recorded (#7912)', () => {
  const result = runReport([
    sample('base', { parseMs: 0, totalMs: 10 }), sample('branch', { parseMs: 10, totalMs: 12 }),
    sample('base', { parseMs: 0, totalMs: 30 }), sample('branch', { parseMs: 10, totalMs: 31 }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.verdict.tooNoisy, true);
  assert.equal(result.report.verdict.zeroBaselineIncrease, true);
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(result.stdout, /VERDICT:.*blocked/);
});

test('keeps neutral and output-count-drift verdict behavior on valid one-pair input', () => {
  const neutral = runReport([sample('base'), sample('branch')]);
  assert.equal(neutral.status, 0, neutral.stderr);
  assert.equal(neutral.report.verdict.realChange, false);
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(neutral.stdout, /within noise/);

  const drift = runReport([sample('base'), sample('branch', { triangles: 5 })]);
  assert.equal(drift.status, 0, drift.stderr);
  assert.equal(drift.report.verdict.fingerprintDrift, true);
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(drift.stdout, /output fingerprint changed/);
});

test('keeps the base-spread noise verdict on valid repeated pairs', () => {
  const noisy = runReport([
    sample('base', { totalMs: 10 }), sample('branch', { totalMs: 12 }),
    sample('base', { totalMs: 30 }), sample('branch', { totalMs: 31 }),
  ]);
  assert.equal(noisy.status, 0, noisy.stderr);
  assert.equal(noisy.report.verdict.tooNoisy, true);
  // @source-text-assertion-ok real reporter stdout/stderr; the helper reads only generated report.json, never source
  assert.match(noisy.stdout, /machine too noisy/);
});
