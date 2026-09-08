/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790: `stitchShards` breaks its merge loop on `handoff < 0` and has
 * no way to tell "this shard reached the end of the real entities" from "this
 * shard's scanner hit an unterminated string or comment and could not go on".
 * Both look like -1, and the second one drops every later shard's records with
 * nothing said -- the same silence #3695 removed from the TypeScript scanning
 * paths, still live on the load path a large model actually takes in a browser.
 *
 * The attribution rule is the one `oversizedIdStarts` already uses, and for
 * the same reason: a shard starts at an arbitrary byte, so it can begin inside
 * a quoted value and "find" an unterminated string that the file does not
 * contain. A stop is real only where it lands at or after the boundary the
 * stitch validated for that shard; below it, it belongs to the speculative
 * prefix the stitch just discarded.
 *
 * Plain arrays here; the pool wiring (that `processParallel` forwards the
 * stitched count to `onEntityIndex`) is pinned in
 * `entity-index-malformed-count.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { stitchShards, type ShardColumns } from './shard-stitch.js';

function shard(
  starts: number[],
  handoff: number,
  malformedStart?: number,
): ShardColumns {
  return {
    ids: Uint32Array.from(starts.map((_, i) => i + 1)),
    starts: Uint32Array.from(starts),
    lengths: Uint32Array.from(starts.map(() => 10)),
    classes: new Uint8Array(starts.length),
    handoff,
    oversizedIdStarts: new Uint32Array(0),
    malformedStart,
  };
}

describe('stitchShards malformed-stop attribution', () => {
  it('reports a stop inside shard 0, which is authoritative from the first byte', () => {
    // Shard 0 begins at the header-skip boundary, so nothing it scans is
    // speculative: a stop it reports is a stop a serial scan makes too.
    // `handoff` is -1 because the scanner could not continue, which is
    // byte-identical to a clean EOF -- the whole reason the flag has to exist.
    const stitched = stitchShards([shard([0, 50], -1, 70), shard([120], -1)]);

    expect(stitched).not.toBeNull();
    expect(stitched!.malformedRecordCount).toBe(1);
    // Shard 1's records go, as they always did. What changes is that the
    // caller is told why.
    expect(Array.from(stitched!.starts)).toEqual([0, 50]);
  });

  it('does NOT report a stop that a discarded speculative prefix invented', () => {
    // Shard 1 started mid-file inside a quoted value and ran off the end of a
    // string that, in the file's real framing, closes perfectly well. Its stop
    // sits at byte 60 -- inside the region shard 0 owns and the stitch drops.
    // Counting it would warn that a clean file loaded short (the #3430 shape).
    const stitched = stitchShards([shard([0, 50], 100), shard([40, 60, 100], -1, 60)]);

    expect(stitched!.malformedRecordCount).toBeUndefined();
  });

  it('keeps a stop that lands exactly where the validated region begins', () => {
    // 100 is the first byte of shard 1's retained region, so a stop there is
    // post-resynchronisation and real. A `>` instead of `>=` would drop it,
    // and an under-report is the silence this issue is about.
    const stitched = stitchShards([shard([0], 100), shard([100, 150], -1, 100)]);

    expect(stitched!.malformedRecordCount).toBe(1);
  });

  it('reports nothing, NOT 0, when no shard recorded a stop', () => {
    // The control, and the one that must not be a hard 0: a shard can only
    // report a stop, never "I reached the end cleanly", so silence from every
    // shard is silence, not a clean bill of health. A 0 here would be a claim
    // no producer made, and would read downstream exactly like a verified
    // clean scan (#3790 round 2).
    const stitched = stitchShards([shard([0, 50], 100), shard([100, 150], -1)]);

    expect(stitched!.malformedRecordCount).toBeUndefined();
  });

  it('ignores a stop from a shard the stitch never used', () => {
    // Shard 0 ended the entities; shard 1 is speculative end to end and its
    // records are not stitched in, so its stop is an artefact of where it
    // started, not something the file contains.
    const stitched = stitchShards([shard([0, 50], -1), shard([70], 200, 90)]);

    expect(stitched!.malformedRecordCount).toBeUndefined();
    expect(Array.from(stitched!.starts)).toEqual([0, 50]);
  });

  it('attributes a stop in the MIDDLE of three shards, and drops the tail with it', () => {
    // N=2 cannot separate "the stop was in the last used shard" from "the stop
    // ended the merge loop", because those are the same shard there. With
    // three, shard 1 stops at byte 160 (inside the region it owns, which begins
    // at the 100 shard 0 validated), so its own handoff is -1 and shard 2 never
    // gets stitched in -- its records go, exactly as a serial scan's would, and
    // the caller has to be told why rather than being handed a short index.
    const stitched = stitchShards([
      shard([0, 50], 100),
      shard([100, 150], -1, 160),
      shard([200, 250], -1),
    ]);

    expect(stitched!.malformedRecordCount).toBe(1);
    expect(Array.from(stitched!.starts)).toEqual([0, 50, 100, 150]);
  });

  it('does not let a middle shard invent a stop out of its speculative prefix', () => {
    // The N=3 counterpart of the two-shard artefact case: shard 1's stop at 80
    // is below the 100 it resynchronised at, so it came from the prefix this
    // stitch drops. Shard 1 hands off normally, shard 2 is stitched in, and
    // nothing is reported -- a file that is fine must not warn.
    const stitched = stitchShards([
      shard([0, 50], 100),
      shard([80, 100, 150], 200, 80),
      shard([200, 250], -1),
    ]);

    expect(stitched!.malformedRecordCount).toBeUndefined();
    expect(Array.from(stitched!.starts)).toEqual([0, 50, 100, 150, 200, 250]);
  });

  it('reads undefined from a producer that reports no stop offset at all', () => {
    // The state on `main` today: the Rust sharded scan has no such offset to
    // give (#3699 is still open), so every shard omits it. That has to reach
    // the parser as "nothing reported", not as proof of a clean scan.
    const stitched = stitchShards([shard([0], 100), shard([100], -1)]);

    expect(stitched!.malformedRecordCount).toBeUndefined();
  });
});
