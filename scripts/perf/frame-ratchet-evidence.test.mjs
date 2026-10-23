// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6975: the committed same-build repeatability evidence recomputes to its own
// verdict, and that verdict is exactly what the `browser-frames` ratchet gates.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CRITERIA, deriveEvidence, rowVerdict } from './frame-ratchet-evidence.mjs';
import { loadCeilingFile } from '../perf-ratchet/ceilings.mjs';
import { frameMetricId, RATCHETED_FRAME_METRICS } from '../perf-ratchet/measure-browser-frames.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const EVIDENCE = JSON.parse(read('./evidence/gpu-frame-timing-6975/frame-ratchet/repeatability.json'));
const CEILINGS = loadCeilingFile(fileURLToPath(new URL('../../tests/perf-ratchets/browser-frames.json', import.meta.url)));

test('#6975 the committed stats, contamination tally and verdicts recompute from the raw per-run values', () => {
  assert.deepEqual(EVIDENCE.criteria, CRITERIA);
  const derived = deriveEvidence(EVIDENCE);
  assert.deepEqual(derived.rows, EVIDENCE.rows);
  assert.deepEqual(derived.contamination, EVIDENCE.contamination);
  assert.deepEqual(derived.ratchet, EVIDENCE.ratchet);
  // Every one of the rig's 96 rows was judged, from at least two builds.
  assert.equal(EVIDENCE.rows.length, 96);
  for (const row of EVIDENCE.rows) assert.ok(Object.keys(row.stats).length >= 2, `${row.fixture}/${row.scenario}/${row.metric}`);
  assert.ok(EVIDENCE.rows.every((r) => r.stats[EVIDENCE.seed]), 'the seed build measured every row');
});

test('#6975 only admitted artifacts carry values; refused ones remain as receipts', () => {
  for (const a of EVIDENCE.artifacts) {
    assert.equal(a.admitted, a.admissionError === null, a.run);
    assert.equal(Object.keys(a.values).length, a.admitted ? 96 : 0, a.run);
    assert.match(a.rawSha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(EVIDENCE.artifacts.some((a) => !a.admitted && a.attempts.some((t) => t.contaminated)), 'a contaminated run is retained');
});

test('#6975 the ratchet gates exactly the supported rows, at the evidence ceilings and tolerances', () => {
  assert.deepEqual([...RATCHETED_FRAME_METRICS].sort(), [...EVIDENCE.ratchet].sort());
  assert.deepEqual(CEILINGS.entries.map((e) => e.id).sort(), EVIDENCE.ratchet.map((k) => frameMetricId(...k.split('/'))).sort());
  for (const key of EVIDENCE.ratchet) {
    const [fixture, scenario, metric] = key.split('/');
    const { verdict } = EVIDENCE.rows.find((r) => r.fixture === fixture && r.scenario === scenario && r.metric === metric);
    const entry = CEILINGS.entries.find((e) => e.id === frameMetricId(fixture, scenario, metric));
    assert.equal(entry.ceiling, verdict.ceiling, key);
    assert.deepEqual(entry.tolerance, verdict.tolerance, key);
    assert.deepEqual(entry.provenance, verdict.provenance, key);
  }
});

test('#6975 the test fixture is a byte-identical admitted artifact of the seed build', () => {
  const raw = read('../../tests/evidence/frame-ratchet-6975/admitted.browser-frames.json');
  const sha = createHash('sha256').update(raw).digest('hex');
  const artifact = EVIDENCE.artifacts.find((a) => a.rawSha256 === sha);
  assert.ok(artifact?.admitted, 'fixture matches an admitted receipt');
  assert.equal(artifact.commit, EVIDENCE.seed);
  const contaminated = JSON.parse(read('../../tests/evidence/frame-ratchet-6975/contaminated-sample.json'));
  const receipt = EVIDENCE.artifacts.find((a) => a.run === contaminated.run && a.rawSha256 === contaminated.rawSha256);
  assert.ok(receipt && !receipt.admitted, 'the contaminated sample comes from a refused run receipt');
  assert.ok(receipt.attempts.some((t) => t.fixture === contaminated.sample.fixture && t.contaminated));
  assert.equal(contaminated.sample.gpuHealth.contaminated, true);
});

// The criteria themselves, on stated distributions (no measured numbers).
const builds = (seedValues, otherValues) => ({
  seed: { runs: seedValues.map((_, i) => `s${i}`), values: seedValues },
  other: { runs: otherValues.map((_, i) => `o${i}`), values: otherValues },
});
const at = new Proxy({}, { get: () => '2026-10-15T00:00:00Z' });
const verdict = (row, b) => rowVerdict(row, b, 'seed', at);
const load = (metric) => ({ fixture: 'F', scenario: 'streaming-load', metric });

test('#6975 criteria: identical runs get an exact ceiling; a spread over the cap stays informational', () => {
  assert.equal(verdict(load('gpu_submits'), builds([8, 8, 8, 8, 8], [9, 9, 9, 9, 9])).kind, 'exact');
  const over = 1 + CRITERIA.relativeSpreadCap * 1.1;
  assert.equal(verdict(load('gpu_draws'), builds([100, 100, 100, 100, 100 * over], [100, 100, 100, 100, 100])).rule, 'noisy');
  // The cap applies within EACH build: a tight seed does not excuse a noisy corroborating build.
  assert.equal(verdict(load('gpu_draws'), builds([100, 100, 100, 100, 100], [100, 100, 100, 100, 100 * over])).rule, 'noisy');
});

test('#6975 criteria: the tolerance covers twice the widest spread and survives lowering to the minimum', () => {
  const v = verdict(load('gpu_write_kib'), builds([1000, 1001, 1002, 1003, 1004], [2000, 2000, 2002, 2003, 2001]));
  assert.equal(v.kind, 'relative');
  assert.equal(v.ceiling, 1004);
  assert.ok(v.tolerance.value >= CRITERIA.toleranceMargin * 0.004 && v.tolerance.value < 1);
  assert.equal(v.provenance.commit, 'seed');
});

test('#6975 criteria: scripted and throttled orbit/hover rows never get a ceiling, however stable', () => {
  for (const metric of ['frames', 'rendered_frames', 'gpu_draws', 'gpu_write_kib']) {
    const row = { fixture: 'F', scenario: 'orbit', metric };
    assert.equal(verdict(row, builds([5, 5, 5, 5, 5], [5, 5, 5, 5, 5])).kind, 'informational', metric);
  }
  assert.throws(() => verdict(load('gpu_draws'), builds([1, 1, 1, 1], [1, 1, 1, 1, 1])), /admitted runs/);
});
