/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical content hashing for `.iflx` bundles.
 *
 * The hash signs a deterministic, length-prefixed serialisation of the
 * file map:
 *
 *   for each path (sorted ASCII ascending):
 *     append u64be(byteLength(path)) || utf8(path)
 *            || u64be(byteLength(file_bytes)) || file_bytes
 *
 * Each variable-length segment is preceded by a fixed-width (8-byte,
 * big-endian) length, so the serialisation is unambiguous (injective)
 * regardless of byte content. Earlier revisions used `0x1f`/`0x1e`
 * delimiters, but those bytes can legitimately appear inside arbitrary
 * binary `file_bytes`, which would have made the hashed stream
 * ambiguous and weakened the second-preimage guarantee of the
 * signature scheme.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md §3.2.
 */

import type { BundleFile } from '../types.js';

const HEX = '0123456789abcdef';
const LENGTH_PREFIX_BYTES = 8;

/** Compute the canonical content hash for a file map. */
export async function canonicalContentHash(files: Map<string, BundleFile>): Promise<string> {
  const encoder = new TextEncoder();
  const sortedPaths = [...files.keys()].sort();

  // Pre-compute total length so we can allocate one buffer.
  let total = 0;
  const pathBytes: Uint8Array[] = [];
  for (const path of sortedPaths) {
    const p = encoder.encode(path);
    pathBytes.push(p);
    const fileBytes = files.get(path)?.bytes;
    if (!fileBytes) continue;
    total += LENGTH_PREFIX_BYTES + p.byteLength + LENGTH_PREFIX_BYTES + fileBytes.byteLength;
  }

  const concat = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < sortedPaths.length; i += 1) {
    const path = sortedPaths[i];
    const file = files.get(path);
    if (!file) continue;
    offset = writeLengthPrefix(concat, offset, pathBytes[i].byteLength);
    concat.set(pathBytes[i], offset);
    offset += pathBytes[i].byteLength;
    offset = writeLengthPrefix(concat, offset, file.bytes.byteLength);
    concat.set(file.bytes, offset);
    offset += file.bytes.byteLength;
  }

  const buffer = concat.buffer.slice(0, concat.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
}

/**
 * Write an 8-byte big-endian length prefix at `offset` and return the
 * new offset. JS bitwise ops truncate to 32 bits, so we shift via
 * integer division to support lengths above 2^32 (Number is exact for
 * byte lengths up to 2^53). Fills least-significant byte first, walking
 * from the last byte back to the first.
 */
function writeLengthPrefix(out: Uint8Array, offset: number, length: number): number {
  let remaining = length;
  for (let i = LENGTH_PREFIX_BYTES - 1; i >= 0; i -= 1) {
    out[offset + i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return offset + LENGTH_PREFIX_BYTES;
}

function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.byteLength; i += 1) {
    const byte = view[i];
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out;
}
