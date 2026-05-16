/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical content hashing for `.iflx` bundles.
 *
 * The hash signs a deterministic serialisation of the file map:
 *
 *   for each path (sorted ASCII ascending):
 *     append utf8(path) || 0x1f || file_bytes || 0x1e
 *
 * `0x1f` (unit separator) and `0x1e` (record separator) are
 * non-printable ASCII control characters that cannot appear in path
 * names (paths are restricted to printable subset of UTF-8 by the
 * bundle loader). They give the hash unambiguous segment boundaries
 * without needing length prefixes.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md §3.2.
 */

import type { BundleFile } from '../types.js';

const UNIT_SEP = 0x1f;
const RECORD_SEP = 0x1e;
const HEX = '0123456789abcdef';

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
    total += p.byteLength + 1 + fileBytes.byteLength + 1;
  }

  const concat = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < sortedPaths.length; i += 1) {
    const path = sortedPaths[i];
    const file = files.get(path);
    if (!file) continue;
    concat.set(pathBytes[i], offset);
    offset += pathBytes[i].byteLength;
    concat[offset] = UNIT_SEP;
    offset += 1;
    concat.set(file.bytes, offset);
    offset += file.bytes.byteLength;
    concat[offset] = RECORD_SEP;
    offset += 1;
  }

  const buffer = concat.buffer.slice(0, concat.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
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
