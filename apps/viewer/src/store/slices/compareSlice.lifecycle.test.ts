/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the compareSlice actions #2802 left untested (roughly 11 of
 * ~17), with particular attention to the run-result lifecycle the issue
 * calls out: `compareRunning` / `compareError` / `compareResult` /
 * `compareRunSeq` / `compareSelectedKey` and `clearCompare`, the state
 * machine a comparison run moves through (idle -> running -> succeeded /
 * failed, and back to idle via `clearCompare`).
 *
 * The slice itself is documented as "deliberately dumb, mirroring
 * `clashSlice` + `useClash`" (compareSlice.ts top-of-file comment): every
 * setter here is an independent reducer with no cross-field invariants of
 * its own. The orchestration that turns these setters into a race-free
 * lifecycle (guarding a superseded run's result from landing over a newer
 * one, clearing stale state on model-content changes) lives in
 * `useCompare.ts`, which is out of scope for this file. What IS in scope,
 * and tested below, is that each setter does exactly what it documents and
 * nothing more — in particular that `clearCompare` resets exactly the four
 * fields it documents and `compareRunSeq` is genuinely monotonic and
 * survives a clear.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createCompareSlice, type CompareSlice } from './compareSlice.js';
import type { CompareResult } from './compareSlice.js';

function makeSlice(): { get: () => CompareSlice } {
  let state: CompareSlice;
  const set = (partial: unknown) => {
    const next = typeof partial === 'function'
      ? (partial as (s: CompareSlice) => Partial<CompareSlice>)(state)
      : partial as Partial<CompareSlice>;
    state = { ...state, ...next };
  };
  state = createCompareSlice(set as never, () => state, {} as never);
  return { get: () => state };
}

function fakeResult(overrides: Partial<CompareResult> = {}): CompareResult {
  return {
    baseModelId: 'a',
    headModelId: 'b',
    baseName: 'A.ifc',
    headName: 'B.ifc',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set(),
    diff: { entries: [], excludedTypes: [], contentMatches: undefined } as unknown as CompareResult['diff'],
    ...overrides,
  };
}

describe('compareSlice - plain UI setters', () => {
  it('setComparePanelVisible sets an explicit value', () => {
    const slice = makeSlice();
    slice.get().setComparePanelVisible(true);
    assert.equal(slice.get().comparePanelVisible, true);
    slice.get().setComparePanelVisible(true);
    assert.equal(slice.get().comparePanelVisible, true);
    slice.get().setComparePanelVisible(false);
    assert.equal(slice.get().comparePanelVisible, false);
  });

  it('toggleComparePanel flips from either starting state', () => {
    const slice = makeSlice();
    assert.equal(slice.get().comparePanelVisible, false);
    slice.get().toggleComparePanel();
    assert.equal(slice.get().comparePanelVisible, true);
    slice.get().toggleComparePanel();
    assert.equal(slice.get().comparePanelVisible, false);
  });

  it('setCompareBaseModelId / setCompareHeadModelId set and clear independently', () => {
    const slice = makeSlice();
    slice.get().setCompareBaseModelId('model-a');
    slice.get().setCompareHeadModelId('model-b');
    assert.equal(slice.get().compareBaseModelId, 'model-a');
    assert.equal(slice.get().compareHeadModelId, 'model-b');
    slice.get().setCompareBaseModelId(null);
    assert.equal(slice.get().compareBaseModelId, null);
    assert.equal(slice.get().compareHeadModelId, 'model-b', 'setting one must not touch the other');
  });

  it('setCompareScope replaces the scope', () => {
    const slice = makeSlice();
    assert.equal(slice.get().compareScope, 'both');
    slice.get().setCompareScope('data');
    assert.equal(slice.get().compareScope, 'data');
    slice.get().setCompareScope('geometry');
    assert.equal(slice.get().compareScope, 'geometry');
  });

  it('setCompareShowUnchanged toggles the ghosting flag', () => {
    const slice = makeSlice();
    assert.equal(slice.get().compareShowUnchanged, false);
    slice.get().setCompareShowUnchanged(true);
    assert.equal(slice.get().compareShowUnchanged, true);
  });

  it('setCompareSelectedKey sets and clears the highlighted row', () => {
    const slice = makeSlice();
    slice.get().setCompareSelectedKey('GUID-123');
    assert.equal(slice.get().compareSelectedKey, 'GUID-123');
    slice.get().setCompareSelectedKey(null);
    assert.equal(slice.get().compareSelectedKey, null);
  });
});

describe('compareSlice - run-result lifecycle', () => {
  let slice: { get: () => CompareSlice };
  beforeEach(() => { slice = makeSlice(); });

  it('idle: starts with no result, not running, no error', () => {
    assert.equal(slice.get().compareResult, null);
    assert.equal(slice.get().compareRunning, false);
    assert.equal(slice.get().compareError, null);
    assert.equal(slice.get().compareRunSeq, 0);
  });

  it('idle -> running: setCompareRunning(true) does not by itself touch result/error', () => {
    slice.get().setCompareError('stale error from a previous attempt');
    slice.get().setCompareRunning(true);
    assert.equal(slice.get().compareRunning, true);
    assert.equal(slice.get().compareError, 'stale error from a previous attempt',
      'clearing the error on a fresh run is the CALLER\'s job (useCompare clears it before setCompareRunning(true))');
  });

  it('running -> succeeded: setCompareResult publishes the result; compareRunning is a separate flag the caller clears', () => {
    slice.get().setCompareRunning(true);
    const result = fakeResult();
    slice.get().setCompareResult(result);
    assert.strictEqual(slice.get().compareResult, result);
    assert.equal(slice.get().compareRunning, true,
      'setCompareResult does not implicitly clear compareRunning - each setter is independent by design');
    slice.get().setCompareRunning(false);
    assert.equal(slice.get().compareRunning, false);
  });

  it('running -> failed: setCompareError + setCompareResult(null) is how a failure is published, and does not touch compareRunSeq', () => {
    slice.get().bumpCompareRunSeq();
    slice.get().setCompareRunning(true);
    slice.get().setCompareError('Comparison failed.');
    slice.get().setCompareResult(null);
    slice.get().setCompareRunning(false);
    assert.equal(slice.get().compareResult, null);
    assert.equal(slice.get().compareError, 'Comparison failed.');
    assert.equal(slice.get().compareRunSeq, 1, 'a failed run must not roll back the completed-run counter');
  });

  it('a second successful run replaces the first result outright (last-wins, no merge)', () => {
    const first = fakeResult({ baseModelId: 'a', headModelId: 'b' });
    const second = fakeResult({ baseModelId: 'a', headModelId: 'c' });
    slice.get().setCompareResult(first);
    slice.get().setCompareResult(second);
    assert.strictEqual(slice.get().compareResult, second);
  });

  it('bumpCompareRunSeq is monotonic across repeated calls', () => {
    slice.get().bumpCompareRunSeq();
    slice.get().bumpCompareRunSeq();
    slice.get().bumpCompareRunSeq();
    assert.equal(slice.get().compareRunSeq, 3);
  });

  it('clearCompare resets exactly result/running/error/selectedKey, leaving A/B/scope/blacklist/matching/runSeq untouched', () => {
    slice.get().setCompareBaseModelId('model-a');
    slice.get().setCompareHeadModelId('model-b');
    slice.get().setCompareScope('geometry');
    slice.get().addCompareExcludedType('IfcOpeningElement');
    slice.get().setCompareMatchByContent(false);
    slice.get().bumpCompareRunSeq();
    slice.get().setCompareResult(fakeResult());
    slice.get().setCompareRunning(true);
    slice.get().setCompareError('boom');
    slice.get().setCompareSelectedKey('GUID-1');

    slice.get().clearCompare();

    assert.equal(slice.get().compareResult, null, 'result must be cleared');
    assert.equal(slice.get().compareRunning, false, 'running must be cleared');
    assert.equal(slice.get().compareError, null, 'error must be cleared');
    assert.equal(slice.get().compareSelectedKey, null, 'selection must be cleared');

    // Documented as "keeps the A/B + scope choices" - and the run-completed
    // counter is documented as "never reset" (mirrors clashRunSeq).
    assert.equal(slice.get().compareBaseModelId, 'model-a');
    assert.equal(slice.get().compareHeadModelId, 'model-b');
    assert.equal(slice.get().compareScope, 'geometry');
    assert.deepStrictEqual(slice.get().compareExcludedTypes, ['IfcOpeningElement']);
    assert.equal(slice.get().compareMatchByContent, false);
    assert.equal(slice.get().compareRunSeq, 1, 'clearCompare must not roll back the completed-run counter');
  });

  it('a superseded run publishing after clearCompare still lands (no guard in the slice itself - documented as the caller\'s responsibility)', () => {
    // This demonstrates the slice's own behaviour, not a bug in it: the slice
    // has no notion of "which run this result belongs to" - that identity
    // check (`isCurrentFor` in useCompare.ts) is what prevents a stale
    // in-flight run's result from landing over a fresher clear/re-run. A
    // caller that skips that check would see exactly this.
    const stale = fakeResult({ headModelId: 'stale-head' });
    slice.get().setCompareResult(stale);
    slice.get().clearCompare();
    assert.equal(slice.get().compareResult, null, 'precondition: clear landed');
    slice.get().setCompareResult(stale); // the "superseded run" publishing late
    assert.strictEqual(slice.get().compareResult, stale,
      'the raw setter has no supersession guard - callers must check before calling it');
  });
});
