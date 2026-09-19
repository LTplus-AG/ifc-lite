/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryDiagnostics } from './diagnostics.js';

/**
 * Which pre-worker pipeline phase (#4902) is still outstanding. Production
 * "Geometry stream stalled... Last rendered meshes: 0" reports (#4884
 * follow-up) cannot currently be told apart by phase — this is what makes
 * that possible: read with {@link GateTracker.getStallPhase} at the instant
 * the consumer's watchdog fires, rather than inferred from elapsed time.
 */
export type StallPhase =
  | 'prepass'
  | 'shard-scan'
  | 'styles-gate'
  | 'entity-index-gate'
  | 'workers';

/**
 * Handed in via `ProcessParallelOptions.stallPhaseHandle` (#4902) and filled
 * in synchronously by the pool with a live `getStallPhase()` reader. Absent
 * `getStallPhase` (before the pool runs, or on a code path that doesn't wire
 * one) is the caller's signal that no phase is known yet.
 */
export interface StallPhaseHandle {
  getStallPhase?: () => StallPhase;
}

/**
 * Tracks which pre-worker gate(s) `geometry-parallel.ts` is still waiting on:
 * the streaming pre-pass itself, the SPIKE sharded entity-index scan
 * (`scan-shard` / `shardResultsRemaining`), and the two chunk-dispatch gates
 * (`styles` and `entity-index` — see `dispatchJobsChunk`). A new sibling
 * module (not `geometry-parallel.ts`, which is size-allowlisted and must not
 * grow) so the gate state has one place a consumer can read it from.
 *
 * Precedence when more than one gate is open at once: the EARLIEST phase in
 * the pipeline wins, because it is the one actually responsible for every
 * later phase staying open too (a stuck shard scan means neither the prepass
 * nor either dispatch gate can ever resolve).
 */
export class GateTracker {
  private shardScanOpen = false;
  private prepassOpen = true;
  private stylesOpen = true;
  private entityIndexOpen = true;

  /** The SPIKE sharded scan dispatched shard-scan to the workers. */
  markShardScanStarted(): void {
    this.shardScanOpen = true;
  }

  /** Every shard result is in (stitched or fell back to the serial pre-pass). */
  markShardScanDone(): void {
    this.shardScanOpen = false;
  }

  /** The pre-pass worker's `complete` event arrived. */
  markPrepassDone(): void {
    this.prepassOpen = false;
  }

  /** The `styles` event (serial or the sharded finalize's synthesized one)
   *  reached `dispatchJobsChunk`'s gate. */
  markStylesReceived(): void {
    this.stylesOpen = false;
  }

  /** The entity index (prepass or sharded-early) reached the same gate. */
  markEntityIndexReceived(): void {
    this.entityIndexOpen = false;
  }

  /** Which phase a consumer's watchdog should attribute a stall to right now. */
  getStallPhase(): StallPhase {
    if (this.shardScanOpen) return 'shard-scan';
    if (this.prepassOpen) return 'prepass';
    if (this.stylesOpen) return 'styles-gate';
    if (this.entityIndexOpen) return 'entity-index-gate';
    return 'workers';
  }
}

// Bound for a pre-worker phase that waits on a single worker's reply (a shard
// scan, one style slice, styles finalize). Mirrors the desktop first-batch
// floor/ramp in watchdog.ts (15_000 + MB*30) rather than the browser one
// (30_000 + MB*60): several of these bounds can be outstanding in the same
// load, so each gets the smaller half.
const PRE_WORKER_PHASE_FLOOR_MS = 15_000;
const PRE_WORKER_PHASE_PER_MB_MS = 30;

/** Bound (ms) for one pre-worker single-reply phase, scaled by file size. */
export function preWorkerPhaseBoundMs(fileSizeMB: number): number {
  return Math.max(PRE_WORKER_PHASE_FLOOR_MS, Math.round(PRE_WORKER_PHASE_FLOOR_MS + Math.max(0, fileSizeMB) * PRE_WORKER_PHASE_PER_MB_MS));
}

/**
 * Registry for the pre-worker phase-bound timers (#4979 review). A plain
 * `setTimeout` that is never cancelled keeps its own closure — and whatever
 * it closes over, including the per-load `sharedBuffer` — alive for the FULL
 * bound even after the load completes, fails, or is superseded; on a large
 * file that is real memory held for up to 15s + 30ms/MB for no reason. `arm`
 * tracks the handle and self-removes it once it actually fires; `clearAll` is
 * for the generator's own teardown (`finally`, which also runs on `.return()`
 * / abort), which normally fires first.
 */
export class PhaseBoundTimers {
  private readonly handles = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Arm a bounded wait for a pre-worker phase that depends on a single
   * worker's reply — shard scan, a style slice, styles finalize (#4902).
   * Fires `onTimeout` once, only if `isSettled()` is still false when the
   * bound elapses, so a genuine reply arriving right at the boundary (which
   * flips the call site's own settled flag before this checks it) always
   * wins.
   */
  arm(fileSizeMB: number, isSettled: () => boolean, onTimeout: () => void): void {
    const handle = setTimeout(() => {
      this.handles.delete(handle);
      if (!isSettled()) onTimeout();
    }, preWorkerPhaseBoundMs(fileSizeMB));
    this.handles.add(handle);
  }

  /** Cancel every timer still pending — the load exited before its bound. */
  clearAll(): void {
    for (const handle of this.handles) clearTimeout(handle);
    this.handles.clear();
  }
}

/**
 * The synthetic prepass-stream `styles` event an older engine binary that
 * never resolves any styles already produces byte-identically (default
 * per-type colours, no voids). Reused as the #4902 finalize-timeout
 * fallback: worker[0]'s `styles-final` reply feeds the exact same path
 * (see `geometry-parallel.ts`'s `msg.type === 'styles-final'` handler), so a
 * degraded stream degrades to a shape the pool already handles rather than a
 * new one.
 */
export function emptyStylesPrepassEvent(): { type: 'prepass-stream'; event: Record<string, unknown> } {
  return {
    type: 'prepass-stream',
    event: {
      type: 'styles',
      styleIds: new Uint32Array(0), styleColors: new Uint8Array(0),
      voidKeys: new Uint32Array(0), voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0),
    },
  };
}

/**
 * A `GeometryDiagnostics` fragment carrying exactly one typed pre-worker-phase
 * failure (#4902), for `mergeGeometryDiagnostics`. Every counter besides
 * `failuresByReason` is zero, so merging this in never fabricates CSG
 * activity that did not happen. `schemaVersion: 0` — this is a host-
 * synthesized fragment, not a producer-versioned wasm payload, and
 * `mergeGeometryDiagnostics` takes the max, so it never lowers a real one.
 */
export function preWorkerPhaseFailureDiagnostics(reason: string): GeometryDiagnostics {
  return {
    schemaVersion: 0,
    totalCsgFailures: 0,
    productsWithFailures: 0,
    hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [{ reason, count: 1 }],
    silentNoOps: 0,
    rectFast: {
      fired: 0,
      openingsCut: 0,
      deferHostNotBox: 0,
      deferNotThrough: 0,
      deferOffFace: 0,
      deferNearEdge: 0,
      deferNoOpenings: 0,
    },
    worstHosts: [],
  };
}
