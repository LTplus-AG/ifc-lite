/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-file download state the Sources UI draws (#6375). A file with no
 * entry is idle. A downloaded file drops its entry: from there the model
 * load is the viewport loading card's to report, not the row's.
 */
export type SourceDownloadState =
  | { readonly phase: 'queued' }
  | { readonly phase: 'downloading'; readonly received: number; readonly total?: number }
  | { readonly phase: 'failed' };

/**
 * Percent complete (0-100), or `undefined` while the total is unknown. The
 * numbers come from provider code, including third-party providers, so a
 * total or count that is not a finite, non-negative number counts as unknown
 * rather than becoming a NaN percentage.
 */
export function downloadPercent(state: SourceDownloadState): number | undefined {
  if (state.phase !== 'downloading') return undefined;
  const { received, total } = state;
  if (total === undefined || !Number.isFinite(total) || total < 0) return undefined;
  if (!Number.isFinite(received) || received < 0) return undefined;
  if (total === 0) return 100;
  return Math.min(100, (received / total) * 100);
}

// ── Sync progress, keyed by model id ──
//
// A Sync can be started from the hierarchy's model row or the source
// browser's file row, and `syncSourceModel` dedupes the two onto one run. The
// progress therefore lives beside that run rather than in either caller, so
// both rows draw the same ring whichever one was clicked.

type Listener = () => void;

let syncProgress: ReadonlyMap<string, SourceDownloadState> = new Map();
const listeners = new Set<Listener>();

function publish(next: ReadonlyMap<string, SourceDownloadState>): void {
  syncProgress = next;
  for (const listener of listeners) listener();
}

/** Records a sync's download progress; `undefined` clears it. */
export function setSourceSyncProgress(modelId: string, state: SourceDownloadState | undefined): void {
  if (state === undefined) {
    if (!syncProgress.has(modelId)) return;
    const next = new Map(syncProgress);
    next.delete(modelId);
    publish(next);
    return;
  }
  publish(new Map(syncProgress).set(modelId, state));
}

/** Immutable snapshot, replaced on every change (`useSyncExternalStore`-safe). */
export function getSourceSyncProgress(): ReadonlyMap<string, SourceDownloadState> {
  return syncProgress;
}

export function subscribeSourceSyncProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
