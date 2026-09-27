/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Derived batches (issue #4832): the partial (visibility / X-Ray / promotion)
 * sub-batches built by `Scene.getOrCreatePartialBatch` are re-merges of
 * geometry that a BASE bucket batch draws, drawn INSTEAD of it. Their depth
 * must match the base batch's so a sub-batch and the rest of the scene
 * resolve coplanar faces the same way whichever of the two is on screen. Two
 * things decide that depth: the shared local origin (`mergeGeometry`) and
 * whether the vertices went through the 2^-10 lattice (`quantizeInterleaved`)
 * or stayed f32. (The colour-overlay batches this rule was first written for
 * are gone: overrides shade from the entity colour table, #6076.)
 *
 * Quantization is decided per batch from its own extent (u16 range, ~64 m),
 * so a small subset of a base bucket holding one >64 m element (an f32
 * batch) would quantize on its own.
 *
 * The rule here: a derived batch never decides quantization for itself. It
 * (a) is a subset of exactly one base batch and cannot exceed that batch's
 * extent, and (b) inherits the source batch's f32/quantized decision. A
 * subset of a batch that quantized always quantizes (min/max only tighten,
 * `floor` is monotonic), so `'required'` is an invariant, not a hope —
 * `createSceneBatch` reports when it is broken.
 */

import type { BatchedMesh } from './types.js';

/**
 * How `createSceneBatch` treats vertex quantization:
 * - `'off'`: 28-byte f32 records.
 * - `'auto'`: quantize when the batch extent fits the u16 lattice, else f32
 *   (bucket batches, streaming fragments — the batch IS the depth writer).
 * - `'required'`: derived from a source batch that quantized; a fallback here
 *   would break depth coincidence and is reported (#4832).
 */
export type BatchQuantization = 'off' | 'auto' | 'required';

/** Quantization mode for a batch whose depth must match `sourceBatch`'s. */
export function inheritedQuantization(
  quantizedBatchesEnabled: boolean,
  sourceBatch: BatchedMesh | null | undefined,
): BatchQuantization {
  if (!quantizedBatchesEnabled) return 'off';
  // Source not built yet (mid-stream): nothing to inherit from, so decide like
  // a base batch would.
  if (!sourceBatch) return 'auto';
  return sourceBatch.quantized ? 'required' : 'off';
}

/** Mutable copy of an installed override map, in `Scene.setColorOverrides` input shape. */
export function cloneOverrides(
  overrides: ReadonlyMap<number, readonly [number, number, number, number]>,
): Map<number, [number, number, number, number]> {
  const copy = new Map<number, [number, number, number, number]>();
  for (const [id, c] of overrides) copy.set(id, [c[0], c[1], c[2], c[3]]);
  return copy;
}

/** Repaint installed clash tints when the overlay theme changes (#5490). */
export function remapOverrideColors(
  overrides: ReadonlyMap<number, readonly [number, number, number, number]>,
  pairs: ReadonlyArray<readonly [from: readonly number[], to: readonly number[]]>,
): Map<number, [number, number, number, number]> | null {
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  const moving = pairs.filter(([from, to]) => !same(from, to));
  if (moving.length === 0) return null;
  let changed = false;
  const next = new Map<number, [number, number, number, number]>();
  for (const [id, c] of overrides) {
    const hit = moving.find(([from]) => same(from, c));
    if (hit) changed = true;
    const out = hit ? hit[1] : c;
    next.set(id, [out[0], out[1], out[2], out[3]]);
  }
  return changed ? next : null;
}
