/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeModel } from '../test-support';
import { comparisonFindings, type ComparisonFindingInput } from './comparison';

const models = [fakeModel('base', 'v1.ifc', ['W1', 'W2']), fakeModel('head', 'v2.ifc', ['W1', 'W3'])];

type Current = NonNullable<ComparisonFindingInput['current']>['result'];
type Saved = ComparisonFindingInput['saved'][number];

// Hand-built native shapes: only the fields the review source reads.
const entry = (key: string, state: string, modelId: string, localId: number) => ({
  key, state, changeKinds: state === 'modified' ? ['property'] : [], changedComponents: [],
  ...(state === 'deleted' ? { base: { ref: { modelId, localId }, ifcType: 'IfcWall' } } : { head: { ref: { modelId, localId }, ifcType: 'IfcWall' } }),
});
const live = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  baseName: 'v1.ifc', headName: 'v2.ifc', geometryUnavailable: false, placementOnlyGeometry: false,
  diff: { entries, excludedTypes: [] }, ...extra }) as unknown as Current;
const saved = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 's1', name: 'Saved v1 to v2', geometryUnavailable: false, placementOnlyGeometry: false,
  report: { baseModel: 'v1.ifc', headModel: 'v2.ifc', generatedAt: '2026-01-02T00:00:00.000Z', excludedTypes: [], rows }, ...extra }) as unknown as Saved;
const row = (globalId: string, state: string) => ({ globalId, state, model: 'v2.ifc', ifcType: 'IfcWall', change: '', key: globalId });

test('live changed elements are current findings with the native state verbatim; unchanged rows are skipped', () => {
  const out = comparisonFindings({ current: { result: live([entry('k1', 'added', 'head', 2), entry('k2', 'unchanged', 'head', 1)]), stale: false }, saved: [] }, models);
  assert.deepEqual(out.findings.map(f => [f.nativeStatus, f.lifecycle, f.elements[0].globalId]), [['added', 'observed', 'W3']]);
});

// Invariant: a change a later comparison no longer lists is not a resolution.
test('a saved change absent from the live comparison is not-evaluated, never no-longer-observed', () => {
  const out = comparisonFindings({ current: { result: live([entry('k1', 'added', 'head', 2)]), stale: false },
    saved: [saved([row('W3', 'added'), row('W9', 'added')])] }, models);
  const historical = out.findings.filter(f => f.run.temporal === 'historical');
  assert.deepEqual(historical.map(f => [f.elements[0].globalId, f.lifecycle]), [['W3', 'persistent'], ['W9', 'not-evaluated']]);
  assert.ok(!out.findings.some(f => f.lifecycle === 'no-longer-observed'));
  assert.equal(out.findings.find(f => f.run.temporal === 'current')?.lifecycle, 'persistent', 'the live twin of a saved row persists');
});

test('incomplete comparisons say why: geometry, excluded classes and staleness', () => {
  const out = comparisonFindings({ current: { result: live([], { geometryUnavailable: true, diff: { entries: [], excludedTypes: ['IfcSpace'] } }), stale: true }, saved: [] }, models);
  assert.deepEqual(out.runs[0].incomplete.map(gap => gap.code), ['geometry-unavailable', 'excluded-classes', 'stale']);
  assert.equal(out.runs[0].complete, false);
});

test('saved comparison rows carry the durable model name, never a live model id', () => {
  const out = comparisonFindings({ current: null, saved: [saved([row('W3', 'modified'), row('W4', 'matched')])] }, models);
  assert.equal(out.findings.length, 1, 'native content matches are not findings');
  assert.deepEqual(out.findings[0].elements[0], { globalId: 'W3', modelId: null, modelName: 'v2.ifc', ifcType: 'IfcWall' });
  assert.equal(out.runs[0].capturedAt, '2026-01-02T00:00:00.000Z');
});
