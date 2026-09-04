/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790: `stitchShards` breaks its merge loop on `handoff < 0` and has
 * no way to tell "this shard reached the end of the real entities" from "this
 * shard's scanner hit an unterminated string or comment and could not go on".
 * Both look like -1, and the second one drops every later shard's records with
 * nothing said — the same silence #3695 removed from the TypeScript scanning
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
    // byte-identical to a clean EOF — the whole reason the flag has to exist.
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
    // sits at byte 60 — inside the region shard 0 owns and the stitch drops.
    // Counting it would warn that a clean file loaded short (the #3430 shape).
    const stitched = stitchShards([shard([0, 50], 100), shard([40, 60, 100], -1, 60)]);

    expect(stitched!.malformedRecordCount).toBe(0);
  });

  it('keeps a stop that lands exactly where the validated region begins', () => {
    // 100 is the first byte of shard 1's retained region, so a stop there is
    // post-resynchronisation and real. A `>` instead of `>=` would drop it,
    // and an under-report is the silence this issue is about.
    const stitched = stitchShards([shard([0], 100), shard([100, 150], -1, 100)]);

    expect(stitched!.malformedRecordCount).toBe(1);
  });

  it('reports 0 for a genuine end-of-entities stop', () => {
    // The control: a -1 handoff with no stop recorded is what every clean file
    // produces. If this ever reported 1, every load would carry the warning
    // and the warning would mean nothing.
    const stitched = stitchShards([shard([0, 50], 100), shard([100, 150], -1)]);

    expect(stitched!.malformedRecordCount).toBe(0);
  });

  it('ignores a stop from a shard the stitch never used', () => {
    // Shard 0 ended the entities; shard 1 is speculative end to end and its
    // records are not stitched in, so its stop is an artefact of where it
    // started, not something the file contains.
    const stitched = stitchShards([shard([0, 50], -1), shard([70], 200, 90)]);

    expect(stitched!.malformedRecordCount).toBe(0);
    expect(Array.from(stitched!.starts)).toEqual([0, 50]);
  });

  it('reads 0 from a producer that reports no stop offset at all', () => {
    // The state on `main` today: the Rust sharded scan has no such offset to
    // give (#3699 is still open), so every shard omits it. 0 here is "nothing
    // reported", not proof of a clean scan — see the field doc.
    const stitched = stitchShards([shard([0], 100), shard([100], -1)]);

    expect(stitched!.malformedRecordCount).toBe(0);
  });
});
