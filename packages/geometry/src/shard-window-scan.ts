/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A shard scan that copies only its own byte range into wasm (out-of-core
 * ingest, `?perf.ooc`). `scanEntityIndexShard` takes the bytes it scans as a
 * wasm-bindgen `&[u8]`, so handing it the whole file copies the whole file into
 * every scanning worker's wasm memory, which never shrinks again: exactly the
 * per-worker source copy out-of-core ingest exists to remove.
 *
 * Here a worker hands it a window: one byte before `rangeStart` (so the scan
 * starts mid-file exactly as it does on the whole file, `EntityScanner::new_at`)
 * through `rangeEnd` plus a margin for the record that crosses `rangeEnd`. The
 * scanner only reads forward, so the window scan equals the whole-file scan
 * until it reads the window's end. A result is accepted only where it cannot
 * have: the shard found its handoff, and nothing but STEP whitespace and closed
 * comments lies between its last record and that handoff (a record the window
 * cut, or one the scanner skipped there, would leave its own bytes in that gap),
 * or the window reached the end of the file. Otherwise the window grows, by at
 * most {@link SHARD_WINDOW_MAX_MARGIN_BYTES}: a shard that cannot be confirmed
 * within that (one inside a single huge record, a refused record at its end)
 * returns null, and the load takes the serial pre-pass, which copies nothing
 * into the geometry workers either.
 */

import type { ShardColumns } from './worker-prepass-source.js';

/**
 * What `scanEntityIndexShard` returns; offsets relative to the bytes it was given (`handoff` is the start of the
 * first record at or after the range end, or -1 at the end of the bytes).
 */
export type ShardScanColumns = ShardColumns;

/** A windowed shard scan that no window up to the margin cap could confirm: the load takes the serial pre-pass. */
export interface GeometryWorkerShardRefusedMessage { type: 'shard-result'; shardIndex: number; windowRefused: true }

/** The wasm call a shard scan makes (`IfcAPI.scanEntityIndexShard`). */
export interface ShardScanApi {
  scanEntityIndexShard(data: Uint8Array, rangeStart: number, rangeEnd: number): ShardScanColumns;
}

/** First margin past `rangeEnd`; it grows 8x per retry. Records past 1 MiB are rare. */
export const SHARD_WINDOW_MARGIN_BYTES = 1 << 20;
/** The largest margin tried: a window is at most its shard plus this. */
export const SHARD_WINDOW_MAX_MARGIN_BYTES = 64 << 20;

const isStepSpace = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/** Did this window scan end the way the whole-file scan does? */
function windowScanComplete(window: Uint8Array, shard: ShardScanColumns): boolean {
  const n = shard.ids.length;
  if (shard.handoff < 0 || n === 0) return false;
  for (let i = shard.starts[n - 1] + shard.lengths[n - 1]; i < shard.handoff; i++) {
    if (window[i] === 0x2f && window[i + 1] === 0x2a) { // a closed `/* */` comment, as the scanner skips it
      let close = i + 2;
      while (close + 1 < shard.handoff && !(window[close] === 0x2a && window[close + 1] === 0x2f)) close++;
      if (close + 1 >= shard.handoff) return false;
      i = close + 1;
    } else if (!isStepSpace(window[i])) return false;
  }
  return true;
}

/** Shift window-relative offsets back to file offsets, in place. */
function rebase(shard: ShardScanColumns, base: number): ShardScanColumns {
  if (base === 0) return shard;
  for (let i = 0; i < shard.starts.length; i++) shard.starts[i] += base;
  if (shard.oversizedIdStarts) for (let i = 0; i < shard.oversizedIdStarts.length; i++) shard.oversizedIdStarts[i] += base;
  if (shard.handoff >= 0) shard.handoff += base;
  if (shard.malformedStart !== undefined) shard.malformedStart += base;
  return shard;
}

/**
 * Scan `[rangeStart, rangeEnd)` of `bytes` through windows (see the module
 * comment). `scan` is `scanEntityIndexShard`; the result's offsets are file
 * offsets, as from a scan of the whole file. Null when no window up to the
 * largest margin could be confirmed.
 */
export function scanShardWindowed(
  bytes: Uint8Array,
  rangeStart: number,
  rangeEnd: number,
  scan: (window: Uint8Array, rangeStart: number, rangeEnd: number) => ShardScanColumns,
  marginBytes = SHARD_WINDOW_MARGIN_BYTES,
  maxMarginBytes = SHARD_WINDOW_MAX_MARGIN_BYTES,
): ShardScanColumns | null {
  const from = rangeStart > 0 ? rangeStart - 1 : 0;
  for (let margin = Math.min(Math.max(1, marginBytes), maxMarginBytes); ; margin = Math.min(margin * 8, maxMarginBytes)) {
    const to = Math.min(bytes.length, rangeEnd + margin);
    const window = bytes.subarray(from, to);
    const shard = scan(window, rangeStart - from, rangeEnd - from);
    if (to === bytes.length || windowScanComplete(window, shard)) return rebase(shard, from);
    if (margin === maxMarginBytes) return null;
  }
}

/**
 * {@link scanShardWindowed} through `api`. A runtime that refuses a view over shared memory at the wasm boundary
 * gets a copy of the window (never of the file); `onViewRefused` hears the refusal first, and may rethrow.
 */
export function scanShardWindowedOn(
  api: ShardScanApi,
  bytes: Uint8Array,
  rangeStart: number,
  rangeEnd: number,
  onViewRefused: (error: unknown) => void,
): ShardScanColumns | null {
  return scanShardWindowed(bytes, rangeStart, rangeEnd, (window, start, end) => {
    try {
      return api.scanEntityIndexShard(window, start, end);
    } catch (error) {
      onViewRefused(error);
      return api.scanEntityIndexShard(window.slice(), start, end);
    }
  });
}
