// SPDX-License-Identifier: MPL-2.0
import { createChunkDataPool, materializeToDataTable, readPly, readSplat, ReadStream, type ChunkSource } from '@playcanvas/splat-transform';
import { inspectGaussianDecodeAdmission } from './gaussianAdmission.js';
import { validateGaussianDecoded, gaussianDecodedChannels } from './gaussianDecoded.js';
import type { GaussianCaptureSummary } from './gaussianDecodeSession.js';
import {
  accumulateGaussianBounds, emptyGaussianBounds, gaussianBoundsOrigin, gaussianPositionLayout, gaussianSourcePositions,
  writeRebasedPositions, type GaussianPositionLayout,
} from './gaussianPositionRebase.js';

/**
 * #9018 worker-only streaming decoder. The capture is never read whole: upstream's
 * lazy chunk reader range-reads records straight from the dropped `File`, so the
 * worker holds one decode window at a time instead of the file bytes plus a fully
 * materialized table (about 2.3x the file, which no main-thread saving could
 * offset). `open` validates every row and summarizes the capture in one streaming
 * pass (split across helper workers when there are any); `rows` then decodes and
 * rebases only the windows a request covers. Values are identical to
 * `decodeGaussianFile`, which export still uses.
 */
export interface GaussianDecodeStream {
  readonly summary: GaussianCaptureSummary;
  /** Rebased canonical columns of rows [start, start + count) (validated by the summary pass). */
  rows(start: number, count: number): Promise<Record<string, Float32Array>>;
  /** Hand back columns a caller is done with; later windows decode into them instead of allocating. */
  recycle(columns: Readonly<Record<string, Float32Array>>): void;
  close(): Promise<void>;
}

type ReadSource = Parameters<typeof readPly>[0];


/** A seekable upstream read source over a Blob: every read is a bounded range of the file. */
class BlobReadSource implements ReadSource {
  readonly seekable = true;
  readonly size: number;
  private closed = false;
  constructor(private readonly blob: Blob) { this.size = blob.size; }
  read(start = 0, end = this.size): ReadStream {
    if (this.closed) throw new Error('Source has been closed');
    const from = Math.max(0, Math.min(start, this.size));
    return new BlobReadStream(this.blob, from, Math.max(from, Math.min(end, this.size)));
  }
  close(): void { this.closed = true; }
}

class BlobReadStream extends ReadStream {
  private offset: number;
  constructor(private readonly blob: Blob, start: number, private readonly end: number) { super(end - start); this.offset = start; }
  async pull(target: Uint8Array): Promise<number> {
    const length = Math.min(target.length, this.end - this.offset);
    if (length <= 0) return 0;
    const bytes = new Uint8Array(await this.blob.slice(this.offset, this.offset + length).arrayBuffer());
    target.set(bytes);
    this.offset += bytes.length;
    this.bytesRead += bytes.length;
    return bytes.length;
  }
}

/** Upstream reads at most this many record bytes per chunk; also the decoder's pooled scratch cap. */
const SCRATCH_BYTES = 16 * 1024 * 1024;
const LAYERS = new Set(['position', 'geometric', 'color'] as const);

/** Chunks [first, first + chunks) of `source` as a source of their own, for windowed materialization. */
function windowOf(source: ChunkSource, first: number, chunks: number, rows: number): ChunkSource {
  return {
    meta: { ...source.meta, numGaussians: rows, lodCounts: [rows], numChunks: [chunks] },
    read: request => {
      // materializeToDataTable reads whole chunks; a gather would need its indices offset, and is never issued here.
      if (!('chunkIndex' in request)) throw new Error('A Gaussian decode window reads whole chunks only.');
      return source.read({ ...request, chunkIndex: request.chunkIndex + first });
    },
    close: async () => {},
  };
}

/** One range's validated summary: bounds in source precision and the SH statistics. */
export interface GaussianSummaryPart {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly shDegree: 0 | 1 | 2 | 3;
  readonly bounds: { min: [number, number, number]; max: [number, number, number] };
  readonly effectiveShDegree: 0 | 1 | 2 | 3;
  readonly maxAbsShCoefficient: number;
}

/**
 * Summarizes ranges elsewhere (helper workers). A range it could not take (no helper
 * started) is null and is summarized locally; a validation failure rejects.
 */
export type GaussianRangeSummarizer = (ranges: ReadonlyArray<readonly [number, number]>) => Promise<Array<GaussianSummaryPart | null>>;

interface Decoder {
  readonly count: number;
  readonly shDegree: 0 | 1 | 2 | 3;
  readonly chunkSize: number;
  decodeRange(start: number, end: number): Promise<{ rows: number; columns: { name: string; data: Float32Array }[]; read: (row: number, axis: number) => number }>;
  recycle(columns: Iterable<{ name: string; data: Float32Array }>): void;
  clearRecycled(): void;
  close(): Promise<void>;
}

async function openDecoder(file: File, windowRows: number): Promise<Decoder> {
  const head = await file.slice(0, 65_536).arrayBuffer();
  const admission = await inspectGaussianDecodeAdmission(file, head.slice(0, 4096));
  if (admission.kind !== 'capture') {
    throw new Error(admission.kind === 'invalid' ? admission.reason : 'Not a Gaussian capture.');
  }
  const layout: GaussianPositionLayout = gaussianPositionLayout(new Uint8Array(head), admission.format, admission.recordStride);
  const input = new BlobReadSource(file);
  // Upstream allocates record scratch outside the pool's retained-byte cap; a chunk never exceeds SCRATCH_BYTES of records.
  const chunkSize = Math.max(1, Math.min(windowRows, admission.count, Math.floor(SCRATCH_BYTES / admission.recordStride)));
  const pool = createChunkDataPool({ chunkSize, maxPooledBytes: SCRATCH_BYTES });
  let source: ChunkSource | undefined;
  const close = async () => {
    try {
      if (source) await source.close();
      else input.close();
    } finally { pool.destroy(); }
  };
  try {
    source = await (admission.format === 'splat' ? readSplat(input, pool) : readPly(input, pool));
    const meta = source.meta;
    if (meta.numGaussians !== admission.count || meta.shBands !== admission.shDegree
      || meta.numLods !== 1 || meta.model !== 'default'
      || !['position', 'geometric', 'color'].every(layer => meta.availableLayers.has(layer as 'position' | 'geometric' | 'color'))) {
      throw new Error('Unsupported or inconsistent decoded Gaussian schema.');
    }
    const count = meta.numGaussians;
    const shDegree = meta.shBands as 0 | 1 | 2 | 3;
    gaussianDecodedChannels(count, shDegree);
    const opened = source;
    // Column arrays handed back by the consumer (or by the summary pass), reused as decode destinations.
    const free = new Map<string, Float32Array[]>();
    const take = (name: string, length: number): Float32Array => {
      const list = free.get(name);
      const index = list ? list.findIndex(array => array.length === length) : -1;
      return index >= 0 ? list!.splice(index, 1)[0] : new Float32Array(length);
    };
    return {
      count, shDegree, chunkSize, close,
      recycle(columns) {
        for (const { name, data } of columns) {
          if (!(data instanceof Float32Array) || data.buffer.byteLength === 0) continue; // detached or foreign
          const list = free.get(name) ?? [];
          if (list.length < 2) list.push(data); // one window in use, one prefetched
          free.set(name, list);
        }
      },
      clearRecycled: () => free.clear(),
      /** Decode rows [start, end) (chunk-aligned window, sliced) with their source centre reader. */
      async decodeRange(start, end) {
        const first = Math.floor(start / chunkSize);
        const last = Math.ceil(end / chunkSize);
        const windowStart = first * chunkSize;
        const windowEnd = Math.min(count, last * chunkSize);
        const table = await materializeToDataTable(windowOf(opened, first, last - first, windowEnd - windowStart), pool, LAYERS);
        if (table.numRows !== windowEnd - windowStart) throw new Error('Unsupported or inconsistent decoded Gaussian schema.');
        const rows = end - start;
        const offset = start - windowStart;
        const columns = table.columns.map(column => {
          const data = take(column.name, rows);
          data.set((column.data as Float32Array).subarray(offset, offset + rows));
          return { name: column.name, data };
        });
        const records = layout.needsRecords
          ? new Uint8Array(await file.slice(layout.base + start * layout.stride, layout.base + end * layout.stride).arrayBuffer())
          : undefined;
        return { rows, columns, read: gaussianSourcePositions(layout, rows, columns, records) };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Validate rows [start, end) as decodeGaussianFile does and summarize them. */
async function summarizeWith(decoder: Decoder, start: number, end: number): Promise<GaussianSummaryPart> {
  const { count, shDegree, chunkSize } = decoder;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > count || start >= end) {
    throw new Error('Gaussian summary range outside the capture.');
  }
  const bounds = emptyGaussianBounds();
  const basis = (shDegree + 1) ** 2 - 1;
  let effective = 0;
  let maxAbs = 0;
  for (let at = start; at < end;) {
    const until = Math.min(end, (Math.floor(at / chunkSize) + 1) * chunkSize);
    const window = await decoder.decodeRange(at, until);
    accumulateGaussianBounds(window.read, window.rows, bounds);
    // Centres are checked above in source precision; validate the other channels as decodeGaussianFile does.
    for (const column of window.columns) if (column.name === 'x' || column.name === 'y' || column.name === 'z') column.data.fill(0);
    validateGaussianDecoded(window.rows, shDegree, window.columns, { origin: [0, 0, 0], bounds });
    for (const column of window.columns) {
      if (!column.name.startsWith('f_rest_')) continue;
      const band = Math.floor(Math.sqrt((Number(column.name.slice(7)) % basis) + 1));
      const data = column.data;
      for (let i = 0; i < data.length; i++) {
        const magnitude = Math.abs(data[i]);
        if (magnitude > maxAbs) maxAbs = magnitude;
        if (magnitude !== 0 && band > effective) effective = band;
      }
    }
    decoder.recycle(window.columns);
    at = until;
  }
  return { start, end, count, shDegree, bounds, effectiveShDegree: effective as 0 | 1 | 2 | 3, maxAbsShCoefficient: maxAbs };
}

/** Validate and summarize rows [start, end) of `file` (a helper worker's share of the summary pass). */
export async function summarizeGaussianRange(file: File, windowRows: number, start: number, end: number): Promise<GaussianSummaryPart> {
  const decoder = await openDecoder(file, windowRows);
  try { return await summarizeWith(decoder, start, end); }
  finally { await decoder.close(); }
}

/** One summary from parts that exactly tile [0, count) of the same capture. */
export function mergeGaussianSummaries(parts: readonly GaussianSummaryPart[], count: number, shDegree: 0 | 1 | 2 | 3): GaussianCaptureSummary {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const bounds = emptyGaussianBounds();
  let effective = 0;
  let maxAbs = 0;
  let next = 0;
  for (const part of sorted) {
    if (part.start !== next || part.count !== count || part.shDegree !== shDegree) throw new Error('Gaussian summary parts disagree with the capture.');
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], part.bounds.min[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], part.bounds.max[axis]);
    }
    effective = Math.max(effective, part.effectiveShDegree);
    maxAbs = Math.max(maxAbs, part.maxAbsShCoefficient);
    next = part.end;
  }
  if (next !== count) throw new Error('Gaussian summary parts disagree with the capture.');
  return {
    count, shDegree, centerBounds: bounds, decodeOrigin: gaussianBoundsOrigin(bounds),
    effectiveShDegree: effective as 0 | 1 | 2 | 3, maxAbsShCoefficient: maxAbs,
  };
}

/** `parts` contiguous ranges of [0, count), split on chunk boundaries; fewer when the capture is small. */
export function gaussianSummaryRanges(count: number, chunkSize: number, parts: number): Array<[number, number]> {
  const chunks = Math.ceil(count / chunkSize);
  const used = Math.max(1, Math.min(parts, chunks));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < used; i++) {
    const from = Math.round((chunks * i) / used) * chunkSize;
    const to = Math.min(count, Math.round((chunks * (i + 1)) / used) * chunkSize);
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

/**
 * Open `file` for streaming. `known` (the summary of an earlier open of the same
 * File, or of the helpers that validated it) skips the summary pass: a File's bytes
 * cannot change, so rows read later are the rows that were validated. Otherwise the
 * summary pass validates every row; `helpers` (with `helperCount` workers) take all
 * but the first range in parallel, and a range they cannot take is summarized here.
 */
export async function openGaussianDecodeStream(
  file: File, windowRows: number, known?: GaussianCaptureSummary, helpers?: { count: number; summarize: GaussianRangeSummarizer },
): Promise<GaussianDecodeStream> {
  const decoder = await openDecoder(file, windowRows);
  try {
    const { count, shDegree } = decoder;
    let summary = known;
    if (summary) {
      if (summary.count !== count || summary.shDegree !== shDegree) throw new Error('The Gaussian capture changed since it was opened.');
    } else {
      const [own, ...others] = gaussianSummaryRanges(count, decoder.chunkSize, 1 + Math.max(0, helpers?.count ?? 0));
      const remote: Promise<Array<GaussianSummaryPart | null>> = others.length > 0 && helpers ? helpers.summarize(others) : Promise.resolve(others.map(() => null));
      remote.catch(() => {}); // awaited below, after the local range
      const parts = [await summarizeWith(decoder, own[0], own[1])];
      const shared = await remote;
      for (const [index, range] of others.entries()) parts.push(shared[index] ?? await summarizeWith(decoder, range[0], range[1]));
      summary = mergeGaussianSummaries(parts, count, shDegree);
    }
    const origin = summary.decodeOrigin;
    const decodeRows = async (start: number, rows: number) => {
      const window = await decoder.decodeRange(start, start + rows);
      writeRebasedPositions(window.read, window.rows, window.columns, origin);
      return Object.fromEntries(window.columns.map(column => [column.name, column.data])) as Record<string, Float32Array>;
    };
    // Decodes run one at a time (they share the pool). After serving a request the
    // stream decodes the next window of the same size, so the worker decodes while the
    // renderer places the previous slice: one extra window held, never more.
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(run: () => Promise<T>): Promise<T> => {
      const next = tail.then(run, run);
      tail = next.catch(() => {});
      return next;
    };
    let ahead: { start: number; rows: number; result: Promise<Record<string, Float32Array>> } | null = null;
    return {
      summary,
      rows(start, rows) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rows) || start < 0 || rows < 1 || start + rows > count) {
          return Promise.reject(new Error('Gaussian row request outside the capture.'));
        }
        const result = ahead?.start === start && ahead.rows === rows ? ahead.result : serial(() => decodeRows(start, rows));
        ahead = null;
        const next = start + rows;
        if (next < count) {
          const size = Math.min(rows, count - next);
          const prefetch = serial(() => decodeRows(next, size));
          prefetch.catch(() => {}); // surfaces only if that window is requested
          ahead = { start: next, rows: size, result: prefetch };
        }
        return result;
      },
      recycle(columns) {
        decoder.recycle(Object.entries(columns).map(([name, data]) => ({ name, data })));
      },
      async close() {
        ahead = null;
        decoder.clearRecycled();
        await tail;
        await decoder.close();
      },
    };
  } catch (error) {
    await decoder.close();
    throw error;
  }
}
