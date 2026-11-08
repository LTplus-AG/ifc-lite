/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClashEngine, findDuplicates, type ClashElement } from '@ifc-lite/clash';
import { captureQualityGates, defaultQualityGateConfig, evaluateQualityGates, isQualityGateConfig, isQualityGateSnapshot, qualityBand, displayQualityPercent } from './quality-gate';
import { snapshotClashReport, isSavedClashReport } from './saved-report';
import { useViewerStore } from '@/store';
import { qualityGateDocument } from '../document/clash-quality-report';
import { parseDocumentFile } from '../document/persistence';
import { validateDocumentSpec } from '../document/types';
import { resolve } from '@/i18n/registry';

function box(key: string, model: string, ref: number, x = 0): ClashElement {
  const positions = new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { key, model, ref, tag: 'IfcWall', positions, indices, bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] } };
}
const engine = () => createClashEngine({ backend: 'ts' });
const rule = { id: 'walls', name: 'Walls {Model.Name}', a: 'IfcWall', mode: 'hard' as const };
const run = (elements: ClashElement[]) => engine().run(elements, [rule]);

describe('Object quality gate invariants (#9259)', () => {
  it('counts unique objects instead of pairs, including equal keys in federated models', async () => {
    const result = await run([box('same', 'A', 1), box('same', 'B', 2), box('third', 'B', 3), box('clean', 'B', 4, 10)]);
    assert.equal(result.clashes.length, 3);
    const row = evaluateQualityGates(result)[0];
    assert.equal(row.checked, 4);
    assert.equal(row.affected, 3);
    assert.equal(row.percent, 25);
    assert.deepEqual(row.models, ['A', 'B']);
  });
  it('unions overlapping A/B selections without double counting', async () => {
    const result = await engine().run([box('a', 'A', 1), box('b', 'A', 2, 10)], [{ ...rule, b: 'IfcWall' }]);
    assert.equal(evaluateQualityGates(result)[0].checked, 2);
    assert.equal(evaluateQualityGates(result)[0].percent, 100);
  });
  it('counts all involved duplicate objects and retains clean objects in the denominator', () => {
    const result = findDuplicates([box('same', 'A', 1), box('same', 'B', 2), box('third', 'B', 3), box('clean', 'B', 4, 10)]);
    assert.equal(result.clashes.length, 3);
    const row = evaluateQualityGates(result, false, 'duplicates')[0];
    assert.equal(row.kind, 'duplicates');
    assert.equal(row.checked, 4);
    assert.equal(row.affected, 3);
    assert.equal(row.percent, 25);
  });
  it('never invents a passing result from empty, missing, truncated or stale coverage', async () => {
    const result = await run([box('clean', 'A', 1)]);
    assert.equal(evaluateQualityGates(result)[0].percent, 100);
    assert.equal(evaluateQualityGates(result, true)[0].status, 'outdated');
    const capped = { ...result, truncated: { reason: 'test work cap', droppedPairs: 1 } };
    assert.equal(evaluateQualityGates(capped)[0].status, 'incomplete');
    assert.equal(evaluateQualityGates(capped)[0].percent, null);
    assert.equal(evaluateQualityGates({ ...result, ruleCoverage: undefined })[0].status, 'unavailable');
    const empty = await engine().run([box('clean', 'A', 1)], [{ ...rule, b: 'IfcDoor' }]);
    assert.equal(evaluateQualityGates(empty)[0].status, 'not-evaluated');
    assert.equal(evaluateQualityGates(empty)[0].percent, null);
  });
  it('propagates a real engine work cap without granting a passing category', async () => {
    const result = await engine().run([box('a', 'A', 1), box('b', 'A', 2), box('c', 'A', 3)], [rule], { maxCandidatePairs: 1 });
    assert.ok(result.truncated && result.truncated.droppedPairs > 0);
    const row = evaluateQualityGates(result)[0];
    assert.equal(row.status, 'incomplete');
    assert.equal(row.percent, null);
  });
  it('keeps distinct object references even when an invalid file repeats GlobalIds', async () => {
    const result = await run([box('same', 'A', 1), box('same', 'A', 2, 10)]);
    assert.equal(evaluateQualityGates(result)[0].checked, 2);
  });
  it('classifies exact boundaries before rounding and rejects ambiguous bands', () => {
    const config = defaultQualityGateConfig();
    assert.equal(qualityBand(89.9999, config.clash).label, 'Failed');
    assert.equal(qualityBand(90, config.clash).label, 'Partially passed');
    assert.equal(qualityBand(94.9999, config.clash).label, 'Partially passed');
    assert.equal(qualityBand(95, config.clash).label, 'Passed');
    assert.equal(displayQualityPercent(94.9999), '94.9');
    assert.equal(qualityBand(100, config.clash).label, 'Passed');
    for (const minimum of [NaN, Infinity, -1, 101, 0]) {
      assert.equal(isQualityGateConfig({ ...config, clash: [config.clash[0], { ...config.clash[1], minimum }] }), false);
    }
    assert.equal(isQualityGateConfig({ ...config, duplicates: [] }), false);
    assert.equal(isQualityGateConfig({ ...config, clash: [{ ...config.clash[0], label: ' ' }] }), false);
  });
  it('freezes thresholds and rejects tampered numerical evidence', async () => {
    const result = await run([box('a', 'A', 1)]);
    const config = defaultQualityGateConfig();
    const snapshot = captureQualityGates(result, config, false);
    config.clash[2].label = 'Changed after capture';
    assert.equal(snapshot.config.clash[2].label, 'Passed');
    assert.ok(isQualityGateSnapshot(snapshot));
    assert.equal(isQualityGateSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], percent: 42 }] }), false);
  });
  it('saves raw findings independently of excluded display rows and creates a portable document', async () => {
    const raw = await run([box('a', 'A', 1), box('b', 'A', 2)]);
    const state = useViewerStore.getState();
    const report = snapshotClashReport({ ...state, clashRawResult: raw,
      clashResult: { ...raw, clashes: [], summary: { ...raw.summary, total: 0 } },
      clashSuppressedCount: 1,
    }, 'Quality {Model.Name}', new Date('2026-11-08T12:00:00Z'));
    assert.ok(report);
    assert.equal(report.clashes.length, 0);
    assert.equal(report.qualityGates?.rows[0].affected, 2);
    assert.equal(report.qualityGates?.rows[0].percent, 0);
    assert.ok(isSavedClashReport(report));
    assert.equal(isSavedClashReport({ ...report, models: [] }), false, 'gate model ids must join the saved provenance');
    assert.equal(isSavedClashReport({ ...report, run: { ...report.run, rules: [] } }), false, 'gate rules must join the saved run');
    assert.equal(snapshotClashReport({ ...state, clashRawResult: null, clashResult: raw }, 'No raw')?.qualityGates?.rows[0].status, 'unavailable');
    assert.ok(isSavedClashReport({ ...report, qualityGates: undefined }), 'old reports remain valid');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
    const document = qualityGateDocument(report, resolve, () => png);
    assert.deepEqual(validateDocumentSpec(document), []);
    const reopened = parseDocumentFile(JSON.stringify(document));
    assert.equal(reopened.blocks.filter(block => block.kind === 'image').length, 1);
    const text = reopened.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n');
    assert.match(text, /2 checked · 2 affected/);
    assert.match(text, /2026-11-08T12:00:00/);
    assert.ok(text.includes('Quality {{Model.Name}}'), 'file-supplied braces stay literal');
  });
});
