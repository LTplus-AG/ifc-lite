/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pool half of out-of-core ingest (`?perf.ooc=1`, off by default; mechanism in
 * `out-of-core.ts`). Workers get no source copy and no index of their own: they
 * mesh from a sparse arena fed by range reads against the ONE shared index.
 *
 * The pool owes each worker one `set-sparse-source` message, and can only send
 * it once two things have arrived, in either order: the entity index (shared
 * columns) and the pre-pass `sparse-facts` event (the preamble every sparse
 * source starts from). No job is dispatched before that (`ready`).
 *
 * Where the arena would not give the whole-file output, the load stays on the
 * whole-file path: decided up front for what the host knows (`sparsePoolFor`),
 * and at the `sparse-facts` event for what only the scan of the file shows
 * (the event then carries `unsupported`, and the workers get the index as usual).
 */

import type { GeometryWorkerSetSparseSourceMessage, WorkerSparseStats } from './geometry-worker-sparse.js';
import { globalInstancingApplies, readOutOfCoreBudgetBytes, readOutOfCoreFlag } from './perf-flags.js';

interface SparseFacts { preamble: Uint8Array; inverseTargets: Uint32Array; inverseReferrers: Uint32Array }
interface SparseIndex { ids: SharedArrayBuffer; starts: SharedArrayBuffer; lengths: SharedArrayBuffer }

/** The pool's range-read totals, left on `globalThis.__IFC_LITE_OOC_STATS__` for a harness. */
export interface OutOfCoreStats extends WorkerSparseStats {
  workers: number;
  sourceBytes: number;
  poolMs: number;
  perWorker: WorkerSparseStats[];
}

export function sumSparseStats(perWorker: readonly WorkerSparseStats[]): WorkerSparseStats {
  const total: WorkerSparseStats = { rounds: 0, reads: 0, bytesRead: 0, records: 0, readMs: 0, batches: 0, retries: 0, resets: 0, peakArenaBytes: 0, fetchMs: 0 };
  for (const stats of perWorker) {
    for (const key of Object.keys(total) as Array<keyof WorkerSparseStats>) {
      // The arenas are separate (one per worker): their peak is the largest, not the sum.
      total[key] = key === 'peakArenaBytes' ? Math.max(total[key], stats[key]) : total[key] + stats[key];
    }
  }
  return total;
}

/** What the sparse state needs of the pool that owns it. */
export interface SparsePoolHost {
  /** Record and send a setup message to every worker, replacement workers included. */
  broadcast(setup: (worker: Worker) => void): void;
  /** The whole-file path's index install, for a file the arena cannot serve. */
  shareIndex(ids: SharedArrayBuffer, starts: SharedArrayBuffer, lengths: SharedArrayBuffer): void;
  /** Called once the workers have what they mesh from: jobs may be dispatched. */
  onReady(): void;
}

export class SparsePool {
  /** Every worker has (or will replay) its sparse source, or the index of the whole-file path: jobs may be dispatched. */
  ready = false;
  /** Why this load fell back to the whole-file path after its scan, if it did. */
  refused: string | null = null;
  /** One entry per worker that finished its stream. */
  readonly stats: WorkerSparseStats[] = [];
  private index: SparseIndex | null = null;
  private facts: SparseFacts | null = null;

  constructor(
    private readonly sharedBuffer: SharedArrayBuffer,
    private readonly host: SparsePoolHost,
    private readonly budgetBytes = readOutOfCoreBudgetBytes(),
  ) {}

  /** The shared index columns: the workers look ids up in them from JS and never build an index inside wasm. */
  offerIndex(ids: SharedArrayBuffer, starts: SharedArrayBuffer, lengths: SharedArrayBuffer): void {
    this.index = { ids, starts, lengths };
    this.send();
  }

  /** The pre-pass `sparse-facts` event. */
  offerFacts(event: Record<string, unknown>): void {
    if (typeof event.unsupported === 'string') this.refused = event.unsupported;
    this.facts = {
      preamble: event.preamble as Uint8Array,
      inverseTargets: event.inverseTargets as Uint32Array,
      inverseReferrers: event.inverseReferrers as Uint32Array,
    };
    this.send();
  }

  private send(): void {
    const { index, facts, sharedBuffer, budgetBytes } = this;
    if (this.ready || !index || !facts) return;
    this.ready = true;
    if (this.refused !== null) {
      console.warn(`[stream][ooc] whole-file path: the file has ${this.refused}`);
      this.host.shareIndex(index.ids, index.starts, index.lengths);
      this.host.onReady();
      return;
    }
    // Shared, so N workers (and a replacement) read one copy of the preamble.
    const preamble = new Uint8Array(new SharedArrayBuffer(facts.preamble.byteLength));
    preamble.set(facts.preamble);
    console.log(`[stream][ooc] sparse source: preamble=${preamble.byteLength}B inverseEdges=${facts.inverseTargets.length} budget=${Math.round(budgetBytes / 1048576)}MiB`);
    this.host.broadcast((worker) => {
      worker.postMessage({
        type: 'set-sparse-source',
        sharedBuffer,
        preamble,
        inverseTargets: facts.inverseTargets,
        inverseReferrers: facts.inverseReferrers,
        indexIds: new Uint32Array(index.ids),
        indexStarts: new Uint32Array(index.starts),
        indexLengths: new Uint32Array(index.lengths),
        budgetBytes,
      } satisfies GeometryWorkerSetSparseSourceMessage);
    });
    this.host.onReady();
  }

  /** Log the pool's totals and leave them where a harness can read them. Null for a load that fell back. */
  report(poolMs: number): OutOfCoreStats | null {
    if (this.refused !== null) return null;
    const total = sumSparseStats(this.stats);
    const sourceBytes = this.sharedBuffer.byteLength;
    const summary: OutOfCoreStats = { workers: this.stats.length, sourceBytes, poolMs, ...total, perWorker: this.stats };
    (globalThis as { __IFC_LITE_OOC_STATS__?: OutOfCoreStats }).__IFC_LITE_OOC_STATS__ = summary;
    const mib = (bytes: number): string => (bytes / 1048576).toFixed(1);
    console.log(`[stream][ooc] workers=${summary.workers} read ${mib(total.bytesRead)}MiB of ${mib(sourceBytes)}MiB in ${total.reads} reads (${total.records} records, ${total.rounds} rounds), fetch ${Math.round(total.fetchMs)}ms, retries=${total.retries} resets=${total.resets} peakArena=${mib(total.peakArenaBytes)}MiB`);
    return summary;
  }
}

/**
 * The pool's sparse state when this load runs out of core (`?perf.ooc=1`), else null: the whole-file path.
 *
 * Two host options keep a load on the whole-file path, because their batch setup reads the source in a
 * way an arena cannot answer: merged material layers (a scan for the aggregate relations of layer parts)
 * and the global instance plan (its mapped sources are resolved once, before the arena holds them).
 */
/** `globalInstancing` is the load's plan decision; unset, it is read here. */
export function sparsePoolFor(sharedBuffer: SharedArrayBuffer, host: SparsePoolHost, options?: { mergeLayers?: boolean; globalInstancing?: boolean }): SparsePool | null {
  delete (globalThis as { __IFC_LITE_OOC_STATS__?: OutOfCoreStats }).__IFC_LITE_OOC_STATS__; // never an earlier load's
  if (!readOutOfCoreFlag()) return null;
  const blocker = options?.mergeLayers === true ? 'merged material layers' : (options?.globalInstancing ?? globalInstancingApplies(sharedBuffer.byteLength)) ? 'the global instance plan' : null;
  if (blocker !== null) {
    console.warn(`[stream][ooc] whole-file path: out-of-core ingest does not support ${blocker}`);
    return null;
  }
  return new SparsePool(sharedBuffer, host);
}
