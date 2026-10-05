/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Captured runs for reconciliation (#6921). Invariants: capturing the same
 * native result twice holds it once; at most MAX_RUN_CAPTURES results are
 * pinned, newest first; removing a run drops an outcome computed from it;
 * a session reset releases everything.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import type { CapturedRun } from '@/lib/compare/run-reconcile-types';
import { MAX_RUN_CAPTURES } from './compareRunsSlice';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

const result = (): ClashResult => ({ clashes: [], rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  summary: { total: 0, byStatus: {}, bySeverity: {}, byRule: {} } } as unknown as ClashResult);
let n = 0;
const run = (native = result()): CapturedRun =>
  ({ kind: 'clash', id: `run-${++n}`, capturedAt: '2026-10-05T00:00:00.000Z', modelIds: ['A'], stamp: null, result: native });

describe('compareRunsSlice (#6921)', () => {
  it('holds one capture per native result, bounded and newest first', () => {
    const s = () => useViewerStore.getState();
    const first = run();
    assert.equal(s().addCompareRunCapture(first), first.id);
    assert.equal(s().addCompareRunCapture(run(first.kind === 'clash' ? first.result : result())), first.id, 'the same result is not captured twice');
    const later = Array.from({ length: MAX_RUN_CAPTURES }, () => run());
    for (const capture of later) s().addCompareRunCapture(capture);
    assert.equal(s().compareRunCaptures.length, MAX_RUN_CAPTURES);
    assert.equal(s().compareRunCaptures[0], later.at(-1));
    assert.equal(s().compareRunCaptures.includes(first), false, 'the oldest capture is released');
  });

  it('removing a run drops the outcome computed from it, and a session reset releases all', () => {
    const s = () => useViewerStore.getState();
    const [a, b] = [run(), run()];
    s().addCompareRunCapture(a);
    s().addCompareRunCapture(b);
    const outcome = { ok: false as const, kind: 'clash' as const, baseRunId: a.id, headRunId: b.id, incompatibilities: [] };
    s().setCompareReconciliation({ outcome, comparison: {}, stamps: [] });
    s().removeCompareRunCapture(a.id);
    assert.deepEqual(s().compareRunCaptures.map(r => r.id), [b.id]);
    assert.equal(s().compareReconciliation, null);
    s().setCompareReconciliation({ outcome, comparison: {}, stamps: [] });
    s().resetViewerState();
    assert.deepEqual([s().compareRunCaptures, s().compareReconciliation], [[], null]);
  });
});
