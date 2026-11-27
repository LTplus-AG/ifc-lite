/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker half of out-of-core ingest (`?perf.ooc=1`): the per-load sparse
 * session a geometry worker meshes from instead of a full source copy.
 * See `out-of-core.ts` for the mechanism.
 */

import type { IfcAPI } from '@ifc-lite/wasm';
import {
  batchRoots,
  buildVoidLookup,
  ensureSparseClosure,
  findIndexRow,
  sabByteSource,
  type OutOfCoreByteSource,
  type OutOfCoreIndex,
  type SparseFetchStats,
} from './out-of-core.js';
import { isWasmRuntimeTrap } from './wasm-runtime-trap.js';

export interface GeometryWorkerSetSparseSourceMessage {
  type: 'set-sparse-source';
  sharedBuffer: SharedArrayBuffer;
  /** HEADER plus the records every worker needs (pre-pass `sparse-facts`). */
  preamble: Uint8Array;
  inverseTargets: Uint32Array;
  inverseReferrers: Uint32Array;
  /** The shared entity index, ascending by id. Never copied into wasm. */
  indexIds: Uint32Array;
  indexStarts: Uint32Array;
  indexLengths: Uint32Array;
  /** Arena size past which the worker drops everything but the preamble. */
  budgetBytes: number;
}

/** Posted once per worker at stream end; the pool sums them for the report. */
export interface GeometryWorkerSparseStatsMessage {
  type: 'sparse-stats';
  stats: WorkerSparseStats;
}

export interface WorkerSparseStats extends SparseFetchStats {
  batches: number;
  /** Batches run again because a lookup missed a record the file holds. */
  retries: number;
  resets: number;
  peakArenaBytes: number;
  fetchMs: number;
}

/** What every batch variant takes after its source (`processGeometryBatchSparse` takes exactly these). */
export type BatchCallArgs = Parameters<IfcAPI['processGeometryBatchSparse']>;

/** The wasm surface a sparse session drives. */
export type SparseBatchApi = Pick<IfcAPI,
  | 'sparseBegin' | 'sparseSetInverseEdges' | 'sparseExpand' | 'sparseInstall' | 'sparseMarkAbsent'
  | 'sparseTakeMisses' | 'sparseStats' | 'sparseReset' | 'sparseInvalidateDerived'
  | 'processGeometryBatchSparse' | 'processGeometryBatchPartitionedSparse'>;

/** The largest arena reservation a wasm32 `Vec` can make. */
const MAX_RESERVE_BYTES = 0x7fff_0000;

/**
 * How often one batch may be run again for records the forward walk could not
 * see. Each retry installs every miss the previous run recorded, so a batch
 * needs one retry per level of such hidden dependencies; none of the corpus
 * needed more than one.
 */
export const MAX_MISS_RETRIES = 4;

export class WorkerSparseSession {
  private readonly source: OutOfCoreByteSource;
  private readonly index: OutOfCoreIndex;
  private voidColumns: Uint32Array | null = null;
  private voids = new Map<number, Uint32Array>();
  readonly stats: WorkerSparseStats = {
    rounds: 0, reads: 0, bytesRead: 0, records: 0, readMs: 0,
    batches: 0, retries: 0, resets: 0, peakArenaBytes: 0, fetchMs: 0,
  };

  constructor(private readonly setup: GeometryWorkerSetSparseSourceMessage) {
    this.source = sabByteSource(setup.sharedBuffer);
    this.index = { ids: setup.indexIds, starts: setup.indexStarts, lengths: setup.indexLengths };
  }

  /** Start (or, after a recovery re-init, restart) the wasm session. */
  applyTo(api: SparseBatchApi): void {
    // Reserve the arena once: it then never reallocates. The budget plus headroom for the batch that
    // crosses it, and never more than the arena can hold (every record of the file after the preamble).
    const { preamble, sharedBuffer, budgetBytes } = this.setup;
    const reserve = Math.min(MAX_RESERVE_BYTES, Math.ceil(budgetBytes * 1.25), preamble.byteLength + sharedBuffer.byteLength);
    try {
      api.sparseBegin(preamble, reserve);
    } catch (error) {
      // The pool shares one preamble among its workers: a runtime that refuses that view gets a copy.
      if (isWasmRuntimeTrap(error) || !(preamble.buffer instanceof SharedArrayBuffer)) throw error;
      api.sparseBegin(preamble.slice(), reserve);
    }
    api.sparseSetInverseEdges(this.setup.inverseTargets, this.setup.inverseReferrers);
  }

  private voidLookup(keys: Uint32Array, counts: Uint32Array, values: Uint32Array): Map<number, Uint32Array> {
    if (this.voidColumns !== keys) {
      this.voidColumns = keys;
      this.voids = buildVoidLookup(keys, counts, values);
    }
    return this.voids;
  }

  /**
   * Mesh one batch from the arena: the partitioned variant when `instancing`,
   * else the flat one. The caller owns (and frees) what comes back.
   */
  mesh(api: SparseBatchApi, args: BatchCallArgs, instancing: boolean): ReturnType<IfcAPI['processGeometryBatchSparse']> | ReturnType<IfcAPI['processGeometryBatchPartitionedSparse']> {
    const voids = { keys: args[6], counts: args[7], values: args[8] };
    return instancing
      ? this.runBatch(api, args[0], voids, () => api.processGeometryBatchPartitionedSparse(...args))
      : this.runBatch(api, args[0], voids, () => api.processGeometryBatchSparse(...args));
  }

  /**
   * Fetch what `jobs` needs, run `call`, and run it again if a lookup missed a
   * record the file does hold (a dependency the forward walk cannot see). An
   * output that is replaced is freed here.
   *
   * @throws when the batch still misses records after `MAX_MISS_RETRIES` runs:
   *   its output would not be the whole-file output, so it is not returned.
   */
  runBatch<T extends { free(): void }>(
    api: SparseBatchApi,
    jobs: Uint32Array,
    voids: { keys: Uint32Array; counts: Uint32Array; values: Uint32Array },
    call: () => T,
  ): T {
    const fetchStart = performance.now();
    ensureSparseClosure(api, this.source, this.index, batchRoots(jobs, this.voidLookup(voids.keys, voids.counts, voids.values)), this.stats);
    this.stats.fetchMs += performance.now() - fetchStart;
    this.stats.batches++;
    // The output is a wasm handle this method owns until it returns it: every other way out frees it.
    let output: T | undefined = call();
    try {
      for (let attempt = 0; ; attempt++) {
        // A miss on an id the file does not hold is the whole-file answer too.
        const misses = api.sparseTakeMisses().filter((id) => findIndexRow(this.index.ids, id) >= 0);
        if (misses.length === 0) break;
        output.free();
        output = undefined;
        if (attempt === MAX_MISS_RETRIES) {
          throw new Error(`out-of-core batch still misses ${misses.length} record(s) after ${MAX_MISS_RETRIES} retries (first #${misses[0]})`);
        }
        this.stats.retries++;
        const retryStart = performance.now();
        ensureSparseClosure(api, this.source, this.index, misses, this.stats);
        this.stats.fetchMs += performance.now() - retryStart;
        api.sparseInvalidateDerived();
        output = call();
      }
      const arenaBytes = api.sparseStats()[0] ?? 0;
      if (arenaBytes > this.stats.peakArenaBytes) this.stats.peakArenaBytes = arenaBytes;
      if (arenaBytes > this.setup.budgetBytes) {
        api.sparseReset();
        this.stats.resets++;
      }
    } catch (error) {
      output?.free();
      throw error;
    }
    return output;
  }
}
