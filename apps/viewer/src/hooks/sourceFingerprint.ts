/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { xxhash64 } from '@ifc-lite/cache';

/**
 * Spread-sampled source fingerprint — a fast, strong cache KEY, NOT a full
 * content validation. `buildGeometryCacheKey` folds {@link SourceFingerprint.hex}
 * into the key so the RIGHT entry is looked up; it replaces the old
 * first-4KB+last-4KB FNV-32 fingerprint (32 bits, interior-blind) with a wider
 * 64-bit hash over a head/tail/interior spread plus the exact byte length.
 *
 * ## O(1) sampler — and its deliberate blind spot
 * It touches a FIXED ~160KB spread regardless of file size (head {@link
 * HEAD_TAIL_BYTES} + tail {@link HEAD_TAIL_BYTES} + {@link INTERIOR_WINDOWS}
 * interior windows + the 8-byte length), so it is sub-millisecond even on a
 * 400MB file. That O(1) speed is exactly why it CANNOT be the validation: it
 * never reads the bytes BETWEEN its sample windows. A byte-length-preserving
 * in-place edit that lands in a gap — a GUID patch (GUIDs are a fixed 22 chars),
 * a scripted same-width coordinate/string edit — produces an IDENTICAL
 * fingerprint. For the source-PERSISTING tier that is harmless (it serves cached
 * geometry AND cached source together — self-consistent), but for the
 * source-DECOUPLED (mesh-only) tier, which hydrates cached geometry against the
 * FRESH buffer, an unvalidated gap-edit hit would be a silent chimera (old
 * geometry + new properties).
 *
 * ## Validation lives elsewhere — NOT in this fingerprint
 * A mesh-only hit is validated by the source File's `lastModified` (mtime guard:
 * any real on-disk edit bumps it → safe miss) plus a TRUE full-file content hash
 * (SHA-256, computed off the main thread and re-checked in the background to
 * catch the deliberate mtime-preserving gap edit → purge + reload). See
 * `cacheTier.decideMeshOnlyCacheHit`, `utils/sourceContentHash.ts`, and
 * `useIfcLoader`. This fingerprint's only job is to key the lookup cheaply and
 * make a false key-hit (a genuinely different file mapping to the same entry)
 * astronomically rare, so the mtime / full-hash gate almost never has to reject
 * one. It is still strictly stronger than the old weak key (proved in
 * `sourceFingerprint.test.ts`), but strength of the KEY is a performance
 * property, not the safety guarantee.
 */
export interface SourceFingerprint {
  /** Filename-safe hex of {@link hash} — the content component of the cache key. */
  hex: string;
  /** The same value as a 64-bit int (the numeric form of {@link hex}). */
  hash: bigint;
}

/** Bytes sampled from each end of the file (head + tail). */
export const HEAD_TAIL_BYTES = 64 * 1024;
/** Size of each evenly-spaced interior sample window. */
export const INTERIOR_WINDOW_BYTES = 4 * 1024;
/** Number of interior windows sampled between the head and the tail. */
export const INTERIOR_WINDOWS = 8;

/**
 * Byte ranges sampled from a file of length `len`: head, tail (if it does not
 * overlap the head) and {@link INTERIOR_WINDOWS} interior windows. Pulled out
 * of {@link computeSourceFingerprint} so {@link computeSourceFingerprintFromBlob}
 * — which cannot hold the whole file in memory — samples the EXACT same
 * ranges via `Blob.slice()` instead of `Uint8Array.subarray()`. Same ranges +
 * same length prefix + same hash function means the two functions agree
 * bit-for-bit on the same bytes; identical to a caller either way.
 */
function sampleWindows(len: number): Array<[start: number, end: number]> {
  const windows: Array<[number, number]> = [];

  // Head window.
  windows.push([0, Math.min(HEAD_TAIL_BYTES, len)]);

  // Tail window (only when it does not overlap the head).
  if (len > HEAD_TAIL_BYTES) {
    windows.push([Math.max(HEAD_TAIL_BYTES, len - HEAD_TAIL_BYTES), len]);
  }

  // Interior windows at evenly spaced fractional offsets i/(N+1), clamped to
  // stay inside the buffer. On small files these overlap the head/tail — that is
  // fine (the head/tail already fully cover a small file's content).
  for (let i = 1; i <= INTERIOR_WINDOWS; i++) {
    const center = Math.floor((len * i) / (INTERIOR_WINDOWS + 1));
    const maxStart = Math.max(0, len - INTERIOR_WINDOW_BYTES);
    const start = Math.min(Math.max(0, center - (INTERIOR_WINDOW_BYTES >> 1)), maxStart);
    windows.push([start, Math.min(start + INTERIOR_WINDOW_BYTES, len)]);
  }

  return windows;
}

/** 8-byte little-endian length prefix — folds the exact size into the hash. */
function lengthPrefix(len: number): Uint8Array {
  const lenBuf = new Uint8Array(8);
  new DataView(lenBuf.buffer).setBigUint64(0, BigInt(len), true);
  return lenBuf;
}

function hashParts(parts: Uint8Array[]): SourceFingerprint {
  let total = 0;
  for (const p of parts) total += p.length;
  const sample = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    sample.set(p, off);
    off += p.length;
  }
  const hash = xxhash64(sample);
  return { hex: hash.toString(16), hash };
}

/**
 * Compute the {@link SourceFingerprint} for a source buffer. Touches at most
 * `8 + 2*HEAD_TAIL_BYTES + INTERIOR_WINDOWS*INTERIOR_WINDOW_BYTES` (~160KB)
 * regardless of file size, so it is constant-time in the file length.
 */
export function computeSourceFingerprint(buffer: ArrayBuffer | Uint8Array): SourceFingerprint {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const len = view.length;
  const parts: Uint8Array[] = [lengthPrefix(len)];
  for (const [start, end] of sampleWindows(len)) {
    parts.push(view.subarray(start, end));
  }
  return hashParts(parts);
}

/**
 * Same fingerprint as {@link computeSourceFingerprint}, computed from a
 * `Blob`/`File` via bounded `slice().arrayBuffer()` reads instead of a
 * fully-loaded buffer. Used where only the browser `File` handle is on hand
 * (e.g. `FederatedModel.sourceFile`) and reading the whole file again just to
 * key a lookup would be wasteful — this still only ever touches the same
 * ~160KB spread {@link sampleWindows} defines, regardless of file size.
 */
export async function computeSourceFingerprintFromBlob(blob: Blob): Promise<SourceFingerprint> {
  const len = blob.size;
  const parts: Uint8Array[] = [lengthPrefix(len)];
  for (const [start, end] of sampleWindows(len)) {
    const buf = await blob.slice(start, end).arrayBuffer();
    parts.push(new Uint8Array(buf));
  }
  return hashParts(parts);
}
