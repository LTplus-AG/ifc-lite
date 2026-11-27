/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Out-of-core geometry ingest (`?perf.ooc=1`, off by default).
 *
 * A geometry worker in this mode holds neither the source file nor its own
 * entity index. It keeps a bounded sparse arena inside wasm and, before each
 * batch, reads the byte ranges of the records that batch's reference closure
 * needs: the wasm side walks references through what it already has and names
 * what is missing (`sparseExpand`), this module resolves those ids against the
 * one shared index, reads them with as few range reads as possible and installs
 * them (`sparseInstall`). The byte source is anything that can be read by
 * range synchronously in a worker; today that is the shared source buffer.
 *
 * The meshing itself is the whole-file code over a smaller source, so a batch's
 * output is byte-identical to the whole-file path (`wasm-out-of-core-contracts.mjs`).
 */

import { isWasmRuntimeTrap } from './wasm-runtime-trap.js';

/** Synchronous ranged reads over the IFC source. */
export interface OutOfCoreByteSource {
  readonly size: number;
  /** Bytes `[offset, offset + length)`. The view is only read before the next call. */
  read(offset: number, length: number): Uint8Array;
}

export function sabByteSource(buffer: SharedArrayBuffer): OutOfCoreByteSource {
  return { size: buffer.byteLength, read: (offset, length) => new Uint8Array(buffer, offset, length) };
}

/** The pre-pass entity index, ascending by id, shared by every worker. */
export interface OutOfCoreIndex {
  ids: Uint32Array;
  /** File offsets. A `Float64Array` column carries a file past 4 GiB; nothing below depends on the width. */
  starts: Uint32Array | Float64Array;
  lengths: Uint32Array;
}

/** The wasm methods this module drives (`rust/wasm-bindings/src/api/gpu_meshes/sparse.rs`). */
export interface SparseSourceApi {
  sparseExpand(ids: Uint32Array, maxDepth: number): Uint32Array;
  sparseInstall(spans: Uint32Array, chunk: Uint8Array): void;
  sparseMarkAbsent(ids: Uint32Array): void;
}

export const SPARSE_FULL_CLOSURE = 0xffff_ffff;

/** Row of `id` in the ascending `ids` column, or -1. */
export function findIndexRow(ids: Uint32Array, id: number): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export interface PlannedRead {
  offset: number;
  length: number;
  /** Flat `[id, offsetInRead, length]` triples. */
  spans: Uint32Array;
}

export interface ReadPlanOptions {
  /** Merge two records into one read when at most this many bytes lie between them. */
  gapBytes: number;
  /** Start a new read once one grows past this. */
  maxReadBytes: number;
}

/**
 * Turn a set of wanted ids into range reads: resolve each id, sort by file
 * offset and merge neighbours, so a run of records written together (the usual
 * layout for one element's geometry) costs one read.
 */
export function planReads(
  index: OutOfCoreIndex,
  wanted: Uint32Array,
  options: ReadPlanOptions,
): { reads: PlannedRead[]; absent: Uint32Array } {
  const rows: number[] = [];
  const absent: number[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const row = findIndexRow(index.ids, wanted[i]);
    if (row < 0 || index.lengths[row] === 0) absent.push(wanted[i]);
    else rows.push(row);
  }
  const { starts, lengths, ids } = index;
  rows.sort((a, b) => starts[a] - starts[b]);
  const reads: PlannedRead[] = [];
  let from = 0;
  while (from < rows.length) {
    const readStart = starts[rows[from]];
    let readEnd = readStart + lengths[rows[from]];
    let to = from + 1;
    while (to < rows.length) {
      const start = starts[rows[to]];
      const end = start + lengths[rows[to]];
      if (start - readEnd > options.gapBytes || end - readStart > options.maxReadBytes) break;
      if (end > readEnd) readEnd = end;
      to++;
    }
    const spans = new Uint32Array((to - from) * 3);
    for (let k = from, o = 0; k < to; k++, o += 3) {
      const row = rows[k];
      spans[o] = ids[row];
      spans[o + 1] = starts[row] - readStart;
      spans[o + 2] = lengths[row];
    }
    reads.push({ offset: readStart, length: readEnd - readStart, spans });
    from = to;
  }
  return { reads, absent: Uint32Array.from(absent) };
}

export interface SparseFetchStats {
  /** Walk/install rounds (one per reference depth that needed a read). */
  rounds: number;
  reads: number;
  bytesRead: number;
  records: number;
  readMs: number;
}

/**
 * Default merge rule. A read is served from memory, so the gap only trades install calls against
 * copying bytes nobody asked for.
 */
export const DEFAULT_READ_PLAN: ReadPlanOptions = { gapBytes: 512, maxReadBytes: 2 * 1024 * 1024 };

/**
 * `sparseInstall`, with the whole-file path's answer to a runtime that refuses a view over shared
 * memory at the wasm boundary: the same bytes once more, as a copy.
 */
export function installChunk(api: SparseSourceApi, spans: Uint32Array, chunk: Uint8Array): void {
  try {
    api.sparseInstall(spans, chunk);
  } catch (error) {
    // A trap leaves the instance unusable: it is never the shared-view refusal, and never retried.
    if (isWasmRuntimeTrap(error) || !(chunk.buffer instanceof SharedArrayBuffer)) throw error;
    api.sparseInstall(spans, chunk.slice());
  }
}

/**
 * Install the reference closure of `roots` into the wasm sparse arena. Returns
 * once nothing reachable is missing.
 */
export function ensureSparseClosure(
  api: SparseSourceApi,
  source: OutOfCoreByteSource,
  index: OutOfCoreIndex,
  roots: Uint32Array,
  stats: SparseFetchStats,
  plan: ReadPlanOptions = DEFAULT_READ_PLAN,
): void {
  let walk = roots;
  // Bounded by the file: every round installs or retires each id it was given.
  for (;;) {
    const missing = api.sparseExpand(walk, SPARSE_FULL_CLOSURE);
    if (missing.length === 0) return;
    stats.rounds++;
    const { reads, absent } = planReads(index, missing, plan);
    for (const read of reads) {
      const t0 = performance.now();
      const chunk = source.read(read.offset, read.length);
      stats.readMs += performance.now() - t0;
      installChunk(api, read.spans, chunk);
      stats.reads++;
      stats.bytesRead += read.length;
      stats.records += read.spans.length / 3;
    }
    if (absent.length > 0) api.sparseMarkAbsent(absent);
    walk = missing;
  }
}

/** Host id to opening ids, from the pre-pass void columns. */
export function buildVoidLookup(
  voidKeys: Uint32Array,
  voidCounts: Uint32Array,
  voidValues: Uint32Array,
): Map<number, Uint32Array> {
  const lookup = new Map<number, Uint32Array>();
  let at = 0;
  for (let i = 0; i < voidKeys.length; i++) {
    const count = voidCounts[i] ?? 0;
    lookup.set(voidKeys[i], voidValues.subarray(at, at + count));
    at += count;
  }
  return lookup;
}

/** The ids a batch starts its walk from: its jobs and the openings that cut them. */
export function batchRoots(jobsFlat: Uint32Array, voids: Map<number, Uint32Array>): Uint32Array {
  const roots: number[] = [];
  for (let i = 0; i + 2 < jobsFlat.length; i += 3) {
    const id = jobsFlat[i];
    roots.push(id);
    const openings = voids.get(id);
    if (openings) for (let k = 0; k < openings.length; k++) roots.push(openings[k]);
  }
  return Uint32Array.from(roots);
}
