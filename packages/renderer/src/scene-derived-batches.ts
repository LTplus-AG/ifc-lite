/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Derived batches (issue #4832): the colour-overlay batches built by
 * `Scene.setColorOverrides` and the partial (visibility) sub-batches built by
 * `Scene.getOrCreatePartialBatch` are re-merges of geometry that a BASE bucket
 * batch already draws. The overlay pass tests depth with `depthCompare:
 * 'equal'`, so a derived batch only paints where its depth is BIT-IDENTICAL
 * to the base batch's. Two things decide that depth: the shared local origin
 * (`mergeGeometry`) and whether the vertices went through the 2^-10 lattice
 * (`quantizeInterleaved`) or stayed f32.
 *
 * Quantization is decided per batch from its own extent (u16 range, ~64 m).
 * Base buckets are `cell~colour` (32 m cells) and essentially always
 * quantize; an overlay group keyed by override colour alone spans wherever
 * that colour lands, crosses the limit on any large model, and silently fell
 * back to f32 — lattice-snapped base against raw-f32 overlay, off by up to one
 * step, every overlay fragment rejected. The reverse also happens: a base
 * bucket holding one >64 m element is f32, while a small subset of it
 * quantizes.
 *
 * The rule here: a derived batch never decides quantization for itself. It
 * (a) is grouped by its SOURCE bucket, so it is a subset of exactly one base
 * batch and cannot exceed that batch's extent, and (b) inherits the source
 * batch's f32/quantized decision. A subset of a batch that quantized always
 * quantizes (min/max only tighten, `floor` is monotonic), so `'required'` is
 * an invariant, not a hope — `createSceneBatch` reports when it is broken.
 */

import type { MeshData } from '@ifc-lite/geometry';
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
  // a base batch would. `Scene.finalizeStreaming*` re-applies the installed
  // overrides once the buckets are built, so this choice never outlives them.
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

/**
 * `overrides` with every colour equal to a pair's `from` replaced by its `to`,
 * or `null` when none matches (nothing to repaint). The renderer uses it to
 * carry the clash pair tints across a theme switch (#5490): the override
 * batches bake their colour in, so a theme change has to rebuild them.
 * Exact channel equality is the contract, not a tolerance: the painted colour
 * and the theme field are the same token parsed the same way.
 */
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

/** One overlay group: pieces of a single source bucket sharing an override colour. */
export interface OverrideGroup {
  color: [number, number, number, number];
  meshData: MeshData[];
  /** The bucket batch whose depth this group must match (null when unbuilt / unbucketed). */
  sourceBatch: BatchedMesh | null;
  /** Key of that bucket (null when unbucketed) — recorded so a later rebuild can tell whether the overlay went stale. */
  sourceKey: string | null;
}

/** A bucket `rebuildPendingBatches` just rebuilt, with the decision its previous batch had. */
export interface RebuiltBucket {
  bucket: { key: string; meshData: readonly MeshData[]; batchedMesh: BatchedMesh | null };
  previousQuantized: boolean;
}

/**
 * Whether a non-streaming rebuild invalidated the installed overlays: a
 * rebuilt bucket holding an overridden piece flipped f32↔quantized, or an
 * overridden piece now lives in a different bucket than the one its overlay
 * inherited from (`overlaySources`: piece → source bucket key at build time).
 * Anything else — e.g. N meshes appended one by one into a bucket whose
 * decision holds — leaves the overlays bit-coincident, so rebuilding them
 * would only be quadratic churn.
 */
export function overlaysInvalidatedBy(
  rebuilt: readonly RebuiltBucket[],
  overlaySources: ReadonlyMap<MeshData, string>,
): boolean {
  if (overlaySources.size === 0) return false;
  for (const { bucket, previousQuantized } of rebuilt) {
    const flipped = (bucket.batchedMesh?.quantized !== undefined) !== previousQuantized;
    for (const piece of bucket.meshData) {
      const source = overlaySources.get(piece);
      if (source !== undefined && (flipped || source !== bucket.key)) return true;
    }
  }
  return false;
}

/**
 * Group override pieces by `(source bucket, override colour)`.
 *
 * `sourceOf` resolves a piece to its owning bucket (key + built batch) or
 * undefined when it is not bucketed (textured meshes, mid-stream pieces);
 * `fallbackKey` then supplies a spatial key with the same cell/model shape
 * so unbucketed pieces still group compactly. Fallback keys live in their
 * own namespace: a bucket's key IS a base key, so an unbucketed piece must
 * never share a group (and thus a `sourceBatch`) with a bucketed one.
 */
export function groupOverridePieces(
  overrides: ReadonlyMap<number, readonly [number, number, number, number]>,
  piecesOf: (expressId: number) => readonly MeshData[] | undefined,
  sourceOf: (piece: MeshData) => { key: string; batchedMesh: BatchedMesh | null } | undefined,
  fallbackKey: (piece: MeshData) => string,
  colorKey: (color: readonly [number, number, number, number]) => string,
): Map<string, OverrideGroup> {
  const groups = new Map<string, OverrideGroup>();
  for (const [expressId, color] of overrides) {
    for (const piece of piecesOf(expressId) ?? []) {
      const source = sourceOf(piece);
      const key = `${source ? source.key : `unbucketed:${fallbackKey(piece)}`}:${colorKey(color)}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          color: [color[0], color[1], color[2], color[3]], meshData: [],
          sourceBatch: source?.batchedMesh ?? null, sourceKey: source?.key ?? null,
        };
        groups.set(key, group);
      }
      group.meshData.push(piece);
    }
  }
  return groups;
}
