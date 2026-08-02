/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ASPRS LAS point classification helpers (#1783).
 *
 * The LAS specification (ASPRS LAS 1.1 through 1.4 R15) defines
 * classes 0..22, reserves 23..63 for future ASPRS use, and leaves
 * 64..255 to the producer. Decoders emit the raw per-point byte in
 * `DecodedPointChunk.classifications`; these helpers aggregate that
 * into a per-class histogram and map codes to their standard names so
 * UIs never have to show a bare integer.
 */

import type { DecodedPointChunk } from './types.js';

/** Total number of representable LAS classification codes (one byte). */
export const LAS_CLASS_COUNT = 256;

/**
 * Standard ASPRS class names (LAS 1.4 R15 table 17). Codes 8 and 12
 * were "Model Key-point" / "Overlap" in LAS 1.1–1.3 but are Reserved
 * since 1.4, and R13+ added 19..22; we follow the current spec.
 */
const ASPRS_STANDARD_NAMES: ReadonlyArray<string> = [
  'Created, never classified',
  'Unclassified',
  'Ground',
  'Low vegetation',
  'Medium vegetation',
  'High vegetation',
  'Building',
  'Low point (noise)',
  'Reserved',
  'Water',
  'Rail',
  'Road surface',
  'Reserved',
  'Wire guard (shield)',
  'Wire conductor (phase)',
  'Transmission tower',
  'Wire-structure connector',
  'Bridge deck',
  'High noise',
  'Overhead structure',
  'Ignored ground',
  'Snow',
  'Temporal exclusion',
];

/**
 * Human-readable name for a LAS classification code.
 * 0..22 use the ASPRS standard names, 23..63 are "Reserved" and
 * 64..255 "User defined" per the spec. Out-of-range codes (the byte
 * field can't actually produce them) return "Unknown".
 */
export function lasClassificationName(classId: number): string {
  if (!Number.isInteger(classId) || classId < 0 || classId >= LAS_CLASS_COUNT) return 'Unknown';
  if (classId < ASPRS_STANDARD_NAMES.length) return ASPRS_STANDARD_NAMES[classId];
  if (classId < 64) return 'Reserved';
  return 'User defined';
}

/** Allocate an all-zero per-class histogram (one slot per LAS code). */
export function createClassificationCounts(): Uint32Array {
  return new Uint32Array(LAS_CLASS_COUNT);
}

/**
 * Fold one decoded chunk into a per-class histogram.
 * Returns true when the chunk carried a classifications buffer (so
 * callers can distinguish "no classes anywhere" from "all zeros").
 */
export function accumulateClassificationCounts(
  counts: Uint32Array,
  chunk: Pick<DecodedPointChunk, 'classifications' | 'pointCount'>,
): boolean {
  const classes = chunk.classifications;
  if (!classes) return false;
  // A malformed chunk may declare more points than the buffer holds;
  // never read past the end.
  const n = Math.min(classes.length, chunk.pointCount);
  for (let i = 0; i < n; i++) {
    counts[classes[i]]++;
  }
  return true;
}

export interface ClassificationCountEntry {
  classId: number;
  count: number;
}

/** Non-zero histogram slots as `{ classId, count }`, ascending by code. */
export function classificationCountEntries(counts: Uint32Array): ClassificationCountEntry[] {
  const out: ClassificationCountEntry[] = [];
  const n = Math.min(counts.length, LAS_CLASS_COUNT);
  for (let classId = 0; classId < n; classId++) {
    const count = counts[classId];
    if (count > 0) out.push({ classId, count });
  }
  return out;
}
