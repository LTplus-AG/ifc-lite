/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3395/#3430: which refusals the shard stitch is allowed to report.
 *
 * A geometry worker scans a byte range starting at an arbitrary offset, so it
 * can begin inside a quoted value. `EntityScanner` has no quote context — its
 * only guard is the shape `#<digits>[ws]*=` — so a string literal containing
 * `#4294967297=IFCWALL(` reads as a record and is refused for an oversized
 * express id. Those refusals belong to the speculative prefix the stitch
 * discards, and there can be arbitrarily many of them.
 *
 * So the count the host reports cannot be the per-shard sum: on a file that
 * declares nothing oversized, summing warns the user that a file which is
 * perfectly fine loaded short. `stitchShards` keeps only the offsets at or
 * after the boundary it validated for each shard — the same boundary its
 * records are cut at.
 *
 * These run on plain arrays. The worker-pool wiring (that `processParallel`
 * hands `stitched.oversizedIdCount` to `onEntityIndex` rather than re-summing)
 * is pinned separately in `entity-index-oversized-count.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { stitchShards, type ShardColumns } from './shard-stitch.js';

/**
 * A shard whose records start at `starts`, hands off at `handoff` (-1 at EOF)
 * and refused records at `oversizedIdStarts`.
 */
function shard(
  starts: number[],
  handoff: number,
  oversizedIdStarts: number[] = [],
): ShardColumns {
  return {
    ids: Uint32Array.from(starts.map((_, i) => i + 1)),
    starts: Uint32Array.from(starts),
    lengths: Uint32Array.from(starts.map(() => 10)),
    classes: new Uint8Array(starts.length),
    handoff,
    oversizedIdStarts: Uint32Array.from(oversizedIdStarts),
  };
}

describe('stitchShards refusal attribution', () => {
  it('reports nothing when every refusal came from a discarded speculative prefix', () => {
    // Shard 0 owns [0, 100) and hands off at 100. Shard 1 started mid-file,
    // mis-read a quoted value as records at 40 and 60 — bytes shard 0 already
    // covered — and only resynchronised at the handoff. THE false alarm: the
    // file declares nothing oversized, so the answer must be 0.
    const stitched = stitchShards([
      shard([0, 50], 100),
      shard([40, 60, 100, 150], -1, [40, 60]),
    ]);

    expect(stitched).not.toBeNull();
    expect(stitched!.oversizedIdCount).toBe(0);
    // The records are cut at the same boundary: 40 and 60 are dropped too.
    expect(Array.from(stitched!.starts)).toEqual([0, 50, 100, 150]);
  });

  it('counts a refusal in each retained region once, never twice', () => {
    // Shard 0 refused a real record at 30 (its whole range is retained).
    // Shard 1 re-read that same byte 30 while speculating (dropped) and
    // refused a real one at 130 inside the region it owns (kept). Two, not
    // three: the sum would double-count the one that straddles the boundary.
    const stitched = stitchShards([
      shard([0, 50], 100, [30]),
      shard([40, 100, 150], -1, [30, 130]),
    ]);

    expect(stitched!.oversizedIdCount).toBe(2);
  });

  it('keeps a refusal that sits exactly at the validated boundary region start', () => {
    // 100 is where shard 1's retained region begins, so a refusal at or above
    // it is post-resynchronisation and real. An off-by-one that used `>` would
    // silently drop it, which is the under-report #3395 exists to stop.
    const stitched = stitchShards([shard([0], 100), shard([100, 150], -1, [100])]);

    expect(stitched!.oversizedIdCount).toBe(1);
  });

  it('drops the refusals of shards past a shard that reached EOF', () => {
    // Shard 0 hands off -1: there are no more real entities, so shard 1 is
    // speculative end to end and its records are not stitched in. Its
    // refusals must go with them.
    const stitched = stitchShards([shard([0, 50], -1), shard([70], 200, [70])]);

    expect(stitched!.oversizedIdCount).toBe(0);
    expect(Array.from(stitched!.starts)).toEqual([0, 50]);
  });

  it('returns null when a shard never resynchronised, refusals and all', () => {
    // The handoff is absent from shard 1, so the stitch cannot validate the
    // boundary and the caller falls back to the serial pre-pass. Reporting a
    // count from a stitch that did not happen would be a number attributable
    // to nothing.
    expect(stitchShards([shard([0], 100), shard([40, 60], -1, [40])])).toBeNull();
  });
});
