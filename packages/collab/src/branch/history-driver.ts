/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * History driver — records a `HistorySidecar` entry from a live
 * `CollabSession` on a timer and on demand (see `history.ts`).
 */

import * as Y from 'yjs';
import type { CollabSession } from '../session.js';
import { snapshotToIfcx, type SnapshotOptions } from '../snapshot/to-ifcx.js';
import { extractMinimalLayer } from '../snapshot/minimal-layer.js';
import type { HistoryEntry, HistorySidecar } from './history.js';

/* ------------------------------------------------------------------ */
/* Session driver                                                      */
/* ------------------------------------------------------------------ */

export interface AttachHistoryOptions {
  /** How often to record a snapshot, ms. Default 60_000. */
  intervalMs?: number;
  /** Branch to record on. Default 'main'. */
  branch?: string;
  /** Forwarded to `snapshotToIfcx`. */
  snapshot?: SnapshotOptions;
  /**
   * If true (default), include a minimal-layer diff against the
   * previous entry on the same branch. Diffs make `historySidecar.diff(a, b)`
   * cheaper to compute.
   */
  includeDiff?: boolean;
}

export interface HistoryDriver {
  /**
   * Force a snapshot now. Captures run one at a time in call order; a
   * capture requested after `detach()` (or session dispose) rejects with
   * `HistoryDriverDetachedError` and records nothing.
   */
  capture(label?: string): Promise<HistoryEntry>;
  /** Stop the timer and refuse further captures. Idempotent. */
  detach(): void;
}

/** Rejection of a capture that would have run after its driver detached. */
export class HistoryDriverDetachedError extends Error {
  constructor() {
    super('@ifc-lite/collab: history driver is detached');
    this.name = 'HistoryDriverDetachedError';
  }
}

/**
 * Drive a `HistorySidecar` from a live `CollabSession`. Records a
 * snapshot every `intervalMs`, plus on-demand via `capture(label)`.
 * Detaches itself when the session is disposed.
 */
export function attachHistorySidecar(
  session: CollabSession,
  sidecar: HistorySidecar,
  options: AttachHistoryOptions = {},
): HistoryDriver {
  const intervalMs = options.intervalMs ?? 60_000;
  const branch = options.branch ?? 'main';
  const includeDiff = options.includeDiff ?? true;

  let lastBaseline: Uint8Array | null = null;
  let detached = false;
  // Tail of the capture queue. Captures are serialised: two overlapping
  // captures both diffed against the same `lastBaseline`, and whichever
  // record() resolved LAST won the baseline even when it held the OLDER
  // state, so the next diff silently re-included or skipped changes.
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const runCapture = async (label?: string): Promise<HistoryEntry> => {
    // Re-checked when this capture's turn comes, not when it was queued:
    // a capture still waiting behind another when the driver detached must
    // not record into a history its owner has walked away from.
    if (detached) throw new HistoryDriverDetachedError();
    const ifcx = snapshotToIfcx(session.doc, options.snapshot);
    const diff =
      includeDiff && lastBaseline
        ? extractMinimalLayer(session.doc, lastBaseline, { snapshot: options.snapshot })
        : undefined;
    // Capture the candidate baseline BEFORE record() so we don't read
    // the doc twice with a window in between, but only commit it to
    // `lastBaseline` AFTER record() resolves. If persistence rejects,
    // the next capture must still diff against the previously-recorded
    // state — otherwise history can silently skip changes.
    const nextBaseline = Y.encodeStateAsUpdate(session.doc);
    const entry = await sidecar.record({
      branch,
      snapshot: ifcx,
      diff,
      label,
      authorClientId: session.clientId,
    });
    lastBaseline = nextBaseline;
    return entry;
  };

  const capture = (label?: string): Promise<HistoryEntry> => {
    // An idle driver snapshots synchronously, at the moment of the call; a
    // busy one snapshots when the capture ahead of it has recorded, so its
    // diff is taken against that capture's committed baseline.
    const run = pending === 0 ? runCapture(label) : tail.then(() => runCapture(label));
    pending++;
    const settled = run.finally(() => {
      pending--;
    });
    // The queue only orders captures; each caller still observes its own
    // capture's rejection through `run`.
    tail = settled.then(undefined, () => undefined);
    return run;
  };

  const timer = setInterval(() => {
    // A slow sidecar must not pile timer captures up behind each other.
    if (pending > 0) return;
    void capture().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[collab] history capture failed:', err);
    });
  }, intervalMs);
  // Don't keep Node alive solely for this timer.
  timer.unref?.();

  const detach = () => {
    if (detached) return;
    detached = true;
    clearInterval(timer);
    unsubscribeDispose();
  };
  // Declared after `detach` reads it: `onDispose` runs the listener at once
  // for an already-disposed session.
  let unsubscribeDispose: () => void = () => false;
  unsubscribeDispose = session.onDispose(detach);

  return { capture, detach };
}
