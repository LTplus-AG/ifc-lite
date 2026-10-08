/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { clash, clashResult, covering, fakeModel } from '../test-support';
import { clashFindings, clashGlobalId } from './clash';

const models = [fakeModel('m1', 'arch.ifc', ['W1', 'W2', 'W3'], { W1: 'Level 1' }), fakeModel('m2', 'mep.ifc', ['P1', 'P2', 'P3'])];
const w = (guid: string) => ({ guid, model: 'm1', tag: 'IfcWall' });
const p = (guid: string) => ({ guid, model: 'm2', tag: 'IfcPipeSegment' });
// The baseline names models by an earlier session's ids; only the names are durable.
const earlierNames = { e1: 'arch.ifc', e2: 'mep.ifc' };
const ew = (guid: string) => ({ guid, model: 'e1', tag: 'IfcWall' });
const ep = (guid: string) => ({ guid, model: 'e2', tag: 'IfcPipeSegment' });
const baseline = (...clashes: ReturnType<typeof clash>[]) => ({ result: clashResult(clashes), modelNames: earlierNames, takenAt: Date.UTC(2026, 0, 2) });
const lifecycles = (out: ReturnType<typeof clashFindings>, temporal: 'current' | 'historical') =>
  Object.fromEntries(out.findings.filter(f => f.run.temporal === temporal).map(f => [f.title + f.elements[0].globalId, f.lifecycle]));

test('with no earlier run every live clash is merely observed', () => {
  const out = clashFindings({ current: { result: clashResult([clash('c1', w('W1'), p('P1'))]), stale: false }, baseline: null }, models);
  assert.deepEqual(out.findings.map(f => f.lifecycle), ['observed']);
  assert.equal(out.runs[0].complete, true);
  assert.deepEqual(out.findings[0].storeys, ['Level 1']);
});

// Invariant: only a complete current run can turn a baseline clash into a resolution candidate.
test('a baseline clash missing from a complete current run is a candidate, present ones persist, new ones are new', () => {
  const out = clashFindings({
    current: { result: clashResult([clash('c1', w('W1'), p('P1')), clash('c3', w('W3'), p('P3'))], covering(['W1', 'W2', 'W3'], ['P1', 'P2', 'P3'])), stale: false },
    baseline: baseline(clash('b1', ew('W1'), ep('P1')), clash('b2', ew('W2'), ep('P2'))),
  }, models);
  assert.deepEqual(lifecycles(out, 'current'), { 'IfcWall × IfcPipeSegmentW1': 'persistent', 'IfcWall × IfcPipeSegmentW3': 'new' });
  assert.deepEqual(lifecycles(out, 'historical'), { 'IfcWall × IfcPipeSegmentW1': 'persistent', 'IfcWall × IfcPipeSegmentW2': 'no-longer-observed' });
});

test('a truncated or stale current run never confirms that anything is gone', () => {
  for (const [label, current] of [
    ['truncated', { result: clashResult([], { ...covering(['W2'], ['P2']), truncated: { reason: 'cap of 1000 pairs', droppedPairs: 40 } }), stale: false }],
    ['stale', { result: clashResult([], covering(['W2'], ['P2'])), stale: true }],
  ] as const) {
    const out = clashFindings({ current, baseline: baseline(clash('b2', ew('W2'), ep('P2'))) }, models);
    assert.equal(out.runs.find(r => r.temporal === 'current')?.complete, false, label);
    assert.deepEqual(out.findings.map(f => f.lifecycle), ['not-evaluated'], label);
  }
});

test('the native comparison keeps clashes of a skipped rule not-evaluated even when the run is complete', () => {
  const otherRule = { ...clashResult([]), rulesRun: [{ id: 'other', name: 'Other', a: 'IfcWall', mode: 'hard' as const }] };
  const out = clashFindings({ current: { result: otherRule, stale: false }, baseline: baseline(clash('b2', ew('W2'), ep('P2'))) }, models);
  assert.equal(out.findings[0].lifecycle, 'not-evaluated');
});

test('a truncation reason is carried verbatim; historical elements carry durable names only', () => {
  const out = clashFindings({ current: { result: clashResult([], { truncated: { reason: 'cap of 1000 pairs', droppedPairs: 3 } }), stale: false },
    baseline: baseline(clash('b2', ew('W2'), ep('P2'))) }, models);
  assert.deepEqual(out.runs.find(r => r.temporal === 'current')?.incomplete, [{ code: 'truncated', detail: 'cap of 1000 pairs' }]);
  const [historical] = out.findings;
  assert.deepEqual(historical.elements.map(e => [e.modelId, e.modelName]), [[null, 'arch.ifc'], [null, 'mep.ifc']]);
  assert.equal(historical.evidence.kind, 'clash-baseline');
});

test('instanced occurrence keys fold into the GlobalId only up to the first colon', () => {
  assert.equal(clashGlobalId({ key: '2O2Fr$t4X7Zf8NOew3FLOH:3' }), '2O2Fr$t4X7Zf8NOew3FLOH');
  assert.equal(clashGlobalId({ key: '2O2Fr$t4X7Zf8NOew3FLOH' }), '2O2Fr$t4X7Zf8NOew3FLOH');
});
