/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shard-stitch protocol: N speculative shard scans in, one file-ordered
 * entity index out — plus the count of records the load actually dropped.
 *
 * Split out of `geometry-parallel.ts` (#3395) because the attribution rule
 * below is the whole reason a refusal count on this path can be trusted, and
 * it is worth being able to test on plain arrays rather than through a worker
 * pool. `geometry-parallel.ts` owns the transport; this owns the protocol.
 */

/** One shard's returned columns + handoff (see `scanEntityIndexShard`). */
export interface ShardColumns {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  /** Per-record prepass class (PREPASS_CLASS_*; 4 = IfcStyledItem). */
  classes: Uint8Array;
  /** Global start of the next shard's first real entity, or -1 at EOF. */
  handoff: number;
  /**
   * Global start byte of each record this shard refused for an express id
   * above the u32 bound (#3395) — offsets, not a count, because a shard cannot
   * tell whether its own refusals are real. It starts at an arbitrary byte, so
   * one landing inside a quoted value reads a string literal shaped like
   * `#4294967297=IFCWALL(` as a record and refuses it, on a file that declares
   * nothing oversized. `stitchShards` attributes them (#3430).
   */
  oversizedIdStarts: Uint32Array;
}

/** What one stitch produced. See `stitchShards` below. */
export interface StitchedShards {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  classes: Uint8Array;
  /**
   * Records the load dropped for an express id above the u32 bound, counted
   * ONLY where the stitch retained the bytes that produced them.
   *
   * Not the per-shard sum. `expectedStart` is a real entity start validated by
   * the previous shard, and a scanner's position only advances, so every
   * refusal a shard recorded below it came from the speculative prefix this
   * stitch just dropped — text parsed out of a quoted value, on a file that may
   * declare nothing oversized at all. Summing would warn the user that a file
   * which is fine loaded short (#3430).
   *
   * What it does NOT bound: a `#<digits>=` inside a quoted value that a SERIAL
   * scan would also mis-read still counts, because it counts there too. The
   * target is parity with the serial path, not quote-aware parsing.
   */
  oversizedIdCount: number;
}

/**
 * SPIKE: stitch N speculative shard scans into the full entity index —
 * byte-identical to the single-threaded scan. Port of the native
 * `parallel_scan::stitch`: shard 0 is authoritative (header-aware start); for
 * shard i>0 the previous shard's validated `handoff` is a real entity start, so
 * binary-search shard i's `starts` for it and drop the speculative prefix before
 * it. Concatenates the validated slices in shard order (= file order), so
 * last-wins on a duplicate id is preserved when the worker rebuilds its map.
 *
 * Returns null on the rare "handoff not found" case (speculative overshoot / a
 * record spanning a whole shard), which needs the serial-rescan fallback the JS
 * spike doesn't implement — the caller falls back to the pre-pass's own index.
 */
export function stitchShards(shards: ShardColumns[]): StitchedShards | null {
  const n = shards.length;

  // Phase 1 — locate each shard's validated slice (binary-search the previous
  // shard's handoff) WITHOUT copying, so the output size is exact before any
  // allocation. Exactness matters: the id/start/length columns are allocated
  // SAB-backed below and handed to every worker as full-buffer views, so a
  // cap-sized buffer would let consumers read past the last real record.
  const sliceFrom = new Array<number>(n).fill(0);
  let used = 1;
  let w = shards[0].ids.length; // shard 0 is authoritative, take every record
  // Shard 0 started at the header-skip boundary, so every refusal it made is
  // one a serial scan makes too. Later shards are attributed in the loop.
  let oversizedIdCount = shards[0].oversizedIdStarts.length;
  let expectedStart = shards[0].handoff; // -1 => no more real entities
  for (let i = 1; i < n; i++) {
    // -1 means the previous shard hit EOF: every later shard is speculative
    // end to end, so its records AND its refusals are dropped by breaking.
    if (expectedStart < 0) break;
    // starts is strictly increasing → binary-search for expectedStart.
    const starts = shards[i].starts;
    let lo = 0;
    let hi = starts.length - 1;
    let p = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = starts[mid];
      if (v === expectedStart) { p = mid; break; }
      if (v < expectedStart) lo = mid + 1;
      else hi = mid - 1;
    }
    if (p < 0) {
      // Handoff not present in this shard — fallback path (not implemented here).
      return null;
    }
    sliceFrom[i] = p;
    w += starts.length - p;
    // Refusals are cut at the SAME boundary as the records: scanner positions
    // only advance, so everything below `expectedStart` came from the
    // speculative prefix just dropped, and everything from it on is what a
    // serial scan over those bytes produces.
    const refusals = shards[i].oversizedIdStarts;
    for (let k = 0; k < refusals.length; k++) {
      if (refusals[k] >= expectedStart) oversizedIdCount++;
    }
    expectedStart = shards[i].handoff;
    used = i + 1;
  }

  // Phase 2 — single concatenation copy, straight into SharedArrayBuffer-backed
  // columns. The stitched index used to be copied THREE times per column on the
  // main thread (cap-array stitch → `.slice()` to contiguous → `.set()` into
  // fresh SABs in deliverEntityIndex); writing the stitch output into SABs
  // directly makes index delivery zero-copy (~450 MB of critical-path memcpy
  // saved on a 19M-entity file). `classes` stays plain: its only consumer past
  // the span-extraction loop is the pre-pass worker, which takes it by transfer.
  const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
  const u32Column = (len: number) =>
    new Uint32Array(sabAvailable ? new SharedArrayBuffer(len * 4) : new ArrayBuffer(len * 4));
  const outIds = u32Column(w);
  const outStarts = u32Column(w);
  const outLengths = u32Column(w);
  const outClasses = new Uint8Array(w);
  let o = 0;
  for (let i = 0; i < used; i++) {
    const s = shards[i];
    const p = sliceFrom[i];
    outIds.set(p === 0 ? s.ids : s.ids.subarray(p), o);
    outStarts.set(p === 0 ? s.starts : s.starts.subarray(p), o);
    outLengths.set(p === 0 ? s.lengths : s.lengths.subarray(p), o);
    outClasses.set(p === 0 ? s.classes : s.classes.subarray(p), o);
    o += s.ids.length - p;
  }

  return { ids: outIds, starts: outStarts, lengths: outLengths, classes: outClasses, oversizedIdCount };
}
