/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved analysis runs for reconciliation (#7370) as a native content kind:
 * CAS saves, backup, import and recovery like every other saved library.
 * Session captures stay bounded in `compareRunsSlice`; this library holds
 * only the runs a person explicitly saved, as immutable evidence.
 */

import { create } from 'zustand';
import type { ContentDefinition } from '../storage/content-migration.js';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library.js';
import { decodeSavedAnalysisRun, type SavedAnalysisRun } from '@ifc-lite/sdk/review';

/** Never written by an older viewer; the migration finds nothing and only records its marker. */
export const analysisRunsContent: ContentDefinition<SavedAnalysisRun> = {
  kind: 'analysisRuns', legacyKey: 'ifc-lite-analysis-runs', decode: decodeSavedAnalysisRun,
};

export const useSavedAnalysisRuns = create<{ entries: SavedAnalysisRun[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const analysisRunLibrary = createContentLibrary(analysisRunsContent,
  () => useSavedAnalysisRuns.getState().entries,
  (entries, status) => useSavedAnalysisRuns.setState({ entries, status }));

/** Resolves once the write of `id` in flight settles: true only when it was committed. */
function settled(id: string): Promise<boolean> {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    const check = (state: ContentStatus['items'][string] | undefined) => {
      if (state === 'saving') return false;
      unsubscribe(); resolve(state === undefined || state === 'saved');
      return true;
    };
    unsubscribe = useSavedAnalysisRuns.subscribe(next => { check(next.status.items[id]); });
    check(useSavedAnalysisRuns.getState().status.items[id]);
  });
}

/** Save a run once. Evidence is immutable: a run already saved under its id is left as it is. */
export function saveAnalysisRun(run: SavedAnalysisRun): Promise<boolean> {
  const { entries, status } = useSavedAnalysisRuns.getState();
  const existing = entries.find(entry => entry.id === run.id);
  if (!existing) return analysisRunLibrary.put(run.id, run);
  // Saving again retries a refused write of the evidence already held, never replaces it.
  const state = status.items[existing.id];
  // A write still in flight answers for this save too: success is reported only once it commits.
  if (state === 'saving') return settled(existing.id);
  return state === undefined || state === 'saved' ? Promise.resolve(true) : analysisRunLibrary.put(existing.id, existing);
}

export function deleteSavedAnalysisRun(id: string): Promise<boolean> {
  return analysisRunLibrary.put(id, null);
}
