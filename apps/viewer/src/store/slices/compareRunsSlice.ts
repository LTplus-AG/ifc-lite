/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Completed analysis runs held for cross-revision reconciliation (#6921),
 * and the last reconciliation outcome. Session-only: a capture is the
 * native result object, which names the session's federation model ids.
 */

import type { StateCreator } from 'zustand';
import type { CapturedRun, ReconcileOutcome } from '@/lib/compare/run-reconcile-types';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

/** Bounded so a long session cannot pin unbounded native results in memory. */
export const MAX_RUN_CAPTURES = 8;

export interface CompareRunsSlice {
  /** Newest first. */
  compareRunCaptures: CapturedRun[];
  /** The last outcome and the comparison result it was computed against;
   *  readers ignore it once `compareResult` is a different object. */
  compareReconciliation: { outcome: ReconcileOutcome; comparison: object } | null;
  /** Hold a run; returns the id of the capture (an existing one for the same native result). */
  addCompareRunCapture: (run: CapturedRun) => string;
  removeCompareRunCapture: (id: string) => void;
  setCompareReconciliation: (value: { outcome: ReconcileOutcome; comparison: object } | null) => void;
}

const nativeResult = (run: CapturedRun): object => run.kind === 'clash' ? run.result : run.report;

export const compareRunsTeardown = defineSliceTeardown(
  'compareRunsSlice',
  ['compareRunCaptures', 'compareReconciliation'],
  {
    'session-reset': () => ({ compareRunCaptures: [], compareReconciliation: null }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);

export const createCompareRunsSlice: StateCreator<CompareRunsSlice, [], [], CompareRunsSlice> = (set, get) => ({
  compareRunCaptures: [],
  compareReconciliation: null,
  addCompareRunCapture: (run) => {
    const existing = get().compareRunCaptures.find(entry => nativeResult(entry) === nativeResult(run));
    if (existing) return existing.id;
    set(s => ({ compareRunCaptures: [run, ...s.compareRunCaptures].slice(0, MAX_RUN_CAPTURES) }));
    return run.id;
  },
  removeCompareRunCapture: (id) => set(s => ({
    compareRunCaptures: s.compareRunCaptures.filter(run => run.id !== id),
    compareReconciliation: s.compareReconciliation
      && (s.compareReconciliation.outcome.baseRunId === id || s.compareReconciliation.outcome.headRunId === id)
      ? null : s.compareReconciliation,
  })),
  setCompareReconciliation: (compareReconciliation) => set({ compareReconciliation }),
});
