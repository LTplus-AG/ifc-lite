/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compress an IFC source into the blocks {@link BlockStore} reads (#2183).
 *
 * Kept as a plain function rather than living inside the worker so it is
 * directly testable and so the swap can be exercised synchronously in tests
 * without a Worker at all. The worker is a thin shell around this.
 */

import { deflateSync } from 'fflate';

import { DEFAULT_BLOCK_SIZE, type BlockedPayload } from './block-store.js';

/**
 * Deflate level.
 *
 * 6 rather than 4: measured on the reference model it costs ~1.2 s more of
 * one-time worker CPU and returns 2 MB, and this runs off the main thread
 * while the viewer is already interactive. Level 9 is not worth measuring --
 * deflate's tail is famously poor value and the input is already at 19.7%.
 */
const DEFLATE_LEVEL = 6;

export interface CompressedSource extends BlockedPayload {
  /**
   * FNV-1a over the whole source.
   *
   * Computed HERE, during the same pass, not lazily like the contiguous
   * accessor's. A blocked source cannot hash itself without inflating
   * everything, so the key has to be taken while the bytes are still
   * contiguous -- which is why the `blocked` arm of `IfcSourceTransfer`
   * declares it required rather than nullable.
   */
  contentKey: string;
}

/** Must match `fnv1a` in source-bytes.ts, or the key changes across a swap. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length.toString(16)}-${(h >>> 0).toString(16)}`;
}

/**
 * Split `source` into fixed-size blocks and deflate each one.
 *
 * A block is stored verbatim when deflating it does not shrink it. STEP files
 * embed already-compressed payloads (base64 textures, for one), and without
 * this a pathological source could compress to LARGER than it started -- which
 * would make the whole feature impossible to gate on size honestly.
 */
export function compressSource(
  source: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): CompressedSource {
  if (blockSize <= 0) throw new Error(`compressSource: blockSize must be positive, got ${blockSize}`);

  const totalLength = source.byteLength;
  const blockCount = Math.ceil(totalLength / blockSize);
  const index = new Uint32Array(blockCount + 1);
  const storedMask = new Uint8Array(blockCount);
  const parts: Uint8Array[] = [];

  let written = 0;
  for (let i = 0; i < blockCount; i++) {
    const start = i * blockSize;
    const raw = source.subarray(start, Math.min(start + blockSize, totalLength));
    const deflated = deflateSync(raw, { level: DEFLATE_LEVEL });

    index[i] = written;
    if (deflated.byteLength < raw.byteLength) {
      parts.push(deflated);
      written += deflated.byteLength;
    } else {
      // Verbatim. Copied, because `raw` is a view into the caller's buffer and
      // the whole point is that the caller's buffer becomes collectable.
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      parts.push(copy);
      storedMask[i] = 1;
      written += copy.byteLength;
    }
  }
  index[blockCount] = written;

  const blocks = new Uint8Array(written);
  let at = 0;
  for (const part of parts) {
    blocks.set(part, at);
    at += part.byteLength;
  }

  return {
    blocks,
    index,
    storedMask,
    blockSize,
    totalLength,
    contentKey: fnv1a(source),
  };
}

/**
 * Whether compressing `byteLength` is worth it.
 *
 * The win scales with size but the risk surface (LRU, stitching, the swap,
 * a worker) is constant, so there is a floor below which this is all cost.
 * The threshold is deliberately the size above which the viewer already stops
 * persisting the source to IndexedDB: above it the source is always
 * SharedArrayBuffer-backed, so handing it to the compression worker is
 * zero-copy. Gating lower would drag in the IndexedDB-restore path, which
 * would hand the worker a plain ArrayBuffer and pay a full structured clone
 * on every cache restore.
 */
export const COMPRESSION_MIN_BYTES = 150 * 1024 * 1024;

export function shouldCompressSource(byteLength: number): boolean {
  return byteLength >= COMPRESSION_MIN_BYTES;
}
