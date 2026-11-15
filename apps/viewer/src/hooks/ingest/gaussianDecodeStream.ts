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
 * pass; `rows` then decodes, rebases and validates only the windows a request
 * covers. Values are identical to `decodeGaussianFile`, which export still uses.
 */
export interface GaussianDecodeStream {
  readonly summary: GaussianCaptureSummary;
  /** Rebased, validated canonical columns of rows [start, start + count). */
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

/**
 * Open `file` for streaming. `known` (the summary of an earlier open of the same
 * File) skips the validating summary pass: a File's bytes cannot change, and every
 * window is validated again when it is read.
 */
export async function openGaussianDecodeStream(file: File, windowRows: number, known?: GaussianCaptureSummary): Promise<GaussianDecodeStream> {
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
    const recycle = (columns: Iterable<{ name: string; data: Float32Array }>) => {
      for (const { name, data } of columns) {
        if (!(data instanceof Float32Array) || data.buffer.byteLength === 0) continue; // detached or foreign
        const list = free.get(name) ?? [];
        if (list.length < 2) list.push(data); // one window in use, one prefetched
        free.set(name, list);
      }
    };

    /** Decode rows [start, end) (chunk-aligned window, sliced) with their source centre reader. */
    const decodeRange = async (start: number, end: number) => {
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
    };

    let summary = known;
    if (summary) {
      if (summary.count !== count || summary.shDegree !== shDegree) throw new Error('The Gaussian capture changed since it was opened.');
    } else {
      const bounds = emptyGaussianBounds();
      const basis = (shDegree + 1) ** 2 - 1;
      let effective = 0;
      let maxAbs = 0;
      for (let start = 0; start < count; start += chunkSize) {
        const window = await decodeRange(start, Math.min(count, start + chunkSize));
        accumulateGaussianBounds(window.read, window.rows, bounds);
        // Centres are checked above in source precision; validate the other channels as decodeGaussianFile does.
        for (const column of window.columns) if (column.name === 'x' || column.name === 'y' || column.name === 'z') column.data.fill(0);
        validateGaussianDecoded(window.rows, shDegree, window.columns, { origin: [0, 0, 0], bounds });
        for (const column of window.columns) {
          const match = /^f_rest_(\d+)$/.exec(column.name);
          if (!match) continue;
          const band = Math.floor(Math.sqrt((Number(match[1]) % basis) + 1));
          for (const value of column.data) {
            const magnitude = Math.abs(value);
            if (magnitude > maxAbs) maxAbs = magnitude;
            if (magnitude !== 0 && band > effective) effective = band;
          }
        }
        recycle(window.columns);
      }
      summary = {
        count, shDegree, centerBounds: bounds, decodeOrigin: gaussianBoundsOrigin(bounds),
        effectiveShDegree: effective as 0 | 1 | 2 | 3, maxAbsShCoefficient: maxAbs,
      };
    }
    const origin = summary.decodeOrigin;
    const centerBounds = summary.centerBounds;
    const decodeRows = async (start: number, rows: number) => {
      const window = await decodeRange(start, start + rows);
      writeRebasedPositions(window.read, window.rows, window.columns, origin);
      return validateGaussianDecoded(window.rows, shDegree, window.columns, { origin, bounds: centerBounds }).columns;
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
        recycle(Object.entries(columns).map(([name, data]) => ({ name, data })));
      },
      async close() {
        ahead = null;
        free.clear();
        await tail;
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
