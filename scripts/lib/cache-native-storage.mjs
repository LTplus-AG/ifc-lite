/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Storage-representation checks for `scripts/cache-native-conformance.mjs`
 * (#9584, SPEC.md §12 item 5): every chunk's stored bytes are checked against
 * its decoded payload, never masked, under each writer's own compressor.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A raw payload's length under the native writer's own compressor
 * (`conformance_writer --deflated-length`, which calls the writer's
 * `deflate_raw`). */
export function nativeDeflatedLength(writerBin, work) {
  return (raw) => {
    const file = join(work, 'raw-chunk.bin');
    writeFileSync(file, raw);
    const run = spawnSync(writerBin, ['--deflated-length', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, `conformance_writer --deflated-length failed: ${run.stderr}`);
    return Number(run.stdout.trim());
  };
}

export function stored(sectionBytes, info) {
  return sectionBytes.subarray(info.byteOffset, info.byteOffset + info.byteLength);
}

/**
 * The uncompressed chunk record, after checking the storage representation
 * against it: raw storage is the payload itself and, at or above the 64 KiB
 * floor, was kept only because that writer's OWN compressor did not make it
 * strictly smaller (`deflatedLength`; never inferred from the other writer's
 * compressor); deflated storage inflates to exactly `uncompressedLength`
 * bytes, is strictly smaller, and was only chosen above the floor. Both
 * writers run with compression on, as their defaults are.
 */
export async function payload(cache, sectionBytes, info, where, deflatedLength) {
  const bytes = Buffer.from(stored(sectionBytes, info));
  if (!(info.flags & cache.GeometryChunkFlags.DeflateRaw)) {
    assert.equal(info.flags, 0, `${where}: unknown chunk flags`);
    assert.equal(bytes.length, info.uncompressedLength, `${where}: raw chunk stores its payload`);
    if (bytes.length >= cache.GEOMETRY_CHUNK_COMPRESS_MIN_BYTES) {
      const deflated = await deflatedLength(bytes);
      assert.ok(deflated >= bytes.length, `${where}: stored raw although its compressor gives ${deflated} < ${bytes.length} bytes`);
    }
    return bytes;
  }
  assert.ok(bytes.length < info.uncompressedLength, `${where}: deflate kept only when strictly smaller`);
  assert.ok(info.uncompressedLength >= cache.GEOMETRY_CHUNK_COMPRESS_MIN_BYTES, `${where}: deflate only above the floor`);
  const inflated = Buffer.from(await cache.inflateRaw(bytes));
  assert.equal(inflated.length, info.uncompressedLength, `${where}: inflates to uncompressedLength`);
  return inflated;
}
