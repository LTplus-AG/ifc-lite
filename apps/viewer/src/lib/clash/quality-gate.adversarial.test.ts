/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Independent adversarial checks for object quality gates (#9259). Each case
 * names the invariant it defends; none re-derives the evaluator's formula from
 * its own source.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClashEngine, findDuplicates, type ClashElement } from '@ifc-lite/clash';
import { captureQualityGates, defaultQualityGateConfig, evaluateQualityGates, isQualityGateSnapshot } from './quality-gate';
import { isSavedClashReport, snapshotClashReport } from './saved-report';
import { rememberRunRequest } from './run-request';
import { useViewerStore } from '@/store';

function box(key: string, model: string, ref: number, x = 0): ClashElement {
  const positions = new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { key, model, ref, tag: 'IfcWall', positions, indices, bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] } };
}
const rule = { id: 'walls', name: 'Walls', a: 'IfcWall', mode: 'hard' as const };
const run = (elements: ClashElement[]) => createClashEngine({ backend: 'ts' }).run(elements, [rule]);

describe('Quality gate adversarial invariants (#9259)', () => {
  it('equal express ids in different models are different objects on both sides of the fraction', async () => {
    // Invariant: identity is (model, ref) in BOTH numerator and denominator.
    const result = await run([box('x', 'A', 1), box('y', 'B', 1), box('clean', 'B', 2, 10)]);
    const [row] = evaluateQualityGates(result);
    assert.equal(row.checked, 3);
    assert.equal(row.affected, 2);
  });

  it('a finding whose object is missing from coverage is never scored', async () => {
    // Invariant: affected ⊆ checked, otherwise the row is unverified, not a score.
    const result = await run([box('a', 'A', 1), box('b', 'A', 2)]);
    const coverage = result.ruleCoverage!.map(entry => ({ ...entry, matchedElements: entry.matchedElements!.slice(0, 1) }));
    const [row] = evaluateQualityGates({ ...result, ruleCoverage: coverage });
    assert.equal(row.status, 'unavailable');
    assert.equal(row.percent, null);
    assert.equal(row.affected, null);
  });

  it('a non-terminating fraction survives a JSON round trip through the strict validator', async () => {
    // Invariant: persisted evidence re-validates after storage (percent equality is exact, not approximate).
    const raw = await run([box('a', 'A', 1), box('b', 'A', 2), box('c', 'A', 3, 10)]);
    const report = snapshotClashReport({ ...useViewerStore.getState(), clashRawResult: raw, clashResult: raw }, 'Thirds');
    assert.ok(report);
    assert.equal(report.qualityGates?.rows[0].status, 'evaluated');
    assert.ok(Math.abs(report.qualityGates!.rows[0].percent! - 100 / 3) < 1e-9);
    assert.ok(isSavedClashReport(JSON.parse(JSON.stringify(report))));
  });

  it('clean models that only appear in coverage are part of the saved provenance', async () => {
    // Invariant: every model id a gate row names joins report.models, even with zero findings.
    const raw = await run([box('a', 'A', 1), box('b', 'A', 2), box('clean', 'B', 3, 10)]);
    const report = snapshotClashReport({ ...useViewerStore.getState(), clashRawResult: raw, clashResult: raw }, 'Federated');
    assert.ok(report);
    assert.deepEqual(new Set(report.models.map(model => model.id)), new Set(['A', 'B']));
    assert.deepEqual(report.qualityGates?.rows[0].models.sort(), ['A', 'B']);
  });

  it('a duplicate scan is saved under the duplicate policy, not the clash policy', () => {
    // Invariant: the run kind travels with the raw result, and the frozen row kind matches run.kind.
    const raw = findDuplicates([box('a', 'A', 1), box('b', 'A', 2), box('c', 'A', 3, 10)]);
    rememberRunRequest(raw, { kind: 'duplicates' });
    const config = defaultQualityGateConfig();
    config.duplicates = [{ minimum: 0, label: 'Dup fail', color: '#000000' }, { minimum: 30, label: 'Dup pass', color: '#00ff00' }];
    const report = snapshotClashReport({ ...useViewerStore.getState(), clashRawResult: raw, clashResult: raw }, 'Dups', new Date(), config);
    assert.ok(report);
    assert.equal(report.run.kind, 'duplicates');
    assert.equal(report.qualityGates?.rows[0].kind, 'duplicates');
    assert.equal(report.qualityGates?.rows[0].affected, 2);
    assert.equal(report.qualityGates?.config.duplicates[1].label, 'Dup pass');
    assert.ok(isSavedClashReport(report));
    assert.equal(isSavedClashReport({ ...report, run: { ...report.run, kind: 'clash' } }), false, 'a relabelled run kind cannot reinterpret the gate');
  });

  it('tampered evaluated rows are refused: stale run, affected > checked, inconsistent percent', async () => {
    // Invariant: a stored row cannot claim a passing number its own counts or completeness contradict.
    const raw = await run([box('a', 'A', 1), box('clean', 'A', 2, 10)]);
    const report = snapshotClashReport({ ...useViewerStore.getState(), clashRawResult: raw, clashResult: raw }, 'Tamper');
    assert.ok(report && report.qualityGates);
    const row = report.qualityGates.rows[0];
    assert.equal(row.status, 'evaluated');
    assert.equal(isSavedClashReport({ ...report, completeness: { ...report.completeness, stale: true } }), false);
    assert.equal(isSavedClashReport({ ...report, completeness: { ...report.completeness, truncated: { reason: 'cap', droppedPairs: 1 } } }), false);
    const gates = (patch: Record<string, unknown>) => ({ ...report, qualityGates: { ...report.qualityGates!, rows: [{ ...row, ...patch }] } });
    assert.equal(isSavedClashReport(gates({ affected: 3, checked: 2, percent: -50 })), false);
    assert.equal(isSavedClashReport(gates({ affected: 0, percent: 100 + Number.EPSILON * 64 })), false);
    assert.equal(isSavedClashReport(gates({ status: 'unavailable' })), false, 'a non-evaluated row cannot keep a percentage');
    assert.equal(isQualityGateSnapshot({ ...report.qualityGates, config: { ...report.qualityGates.config, clash: [] } }), false);
  });

  it('a frozen snapshot is independent of the live config object', async () => {
    // Invariant: mutating the band arrays after capture leaves the evidence and its classification untouched.
    const raw = await run([box('a', 'A', 1)]);
    const config = defaultQualityGateConfig();
    const snapshot = captureQualityGates(raw, config, false);
    config.clash[2].minimum = 99.5;
    config.clash.push({ minimum: 100, label: 'Late', color: '#123456' });
    assert.equal(snapshot.config.clash.length, 3);
    assert.equal(snapshot.config.clash[2].minimum, 95);
  });
});
