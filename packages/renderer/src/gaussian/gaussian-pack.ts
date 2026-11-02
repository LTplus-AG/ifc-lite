/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU packing of every Gaussian asset into the single upstream source (#8564).
 * Work is chunked; `checkpoint` runs between chunks and throws to abandon the
 * build, which then retains nothing. All allocation happens before a caller commits.
 */

import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';
import type { GaussianPackedSource } from './gaussian-backend.js';
import { GaussianSplatError } from './gaussian-errors.js';
import { shRotationFor, transformGaussianRows, type SimilarityPlacement } from './gaussian-placement.js';
import type { GaussianSplatBounds } from './gaussian-types.js';

/** Same envelope as the mesh RTE contract's MAX_RTE_LOCAL_METRES: sub-millimetre f32 locals. */
export const MAX_GAUSSIAN_ANCHOR_EXTENT_METRES = 8_192;
/** Rows past this are rejected before allocation; GPU binding limits usually bind first. */
export const MAX_GAUSSIAN_PACKED_ROWS = 1 << 24;
const CHUNK_ROWS = 65_536;

export type ShDegree = 0 | 1 | 2 | 3;
export type Checkpoint = () => void;
export interface PackedSlice { readonly offset: number; readonly rows: number }
export interface PackedScene { readonly source: GaussianPackedSource; readonly slices: ReadonlyMap<number, PackedSlice> }
export interface SliceRows {
  readonly positions: Float32Array;
  readonly scales: Float32Array;
  readonly rotations: Float32Array;
  readonly sphericalHarmonics?: Float32Array;
  readonly bounds: GaussianSplatBounds;
}

export const shBasisCount = (degree: ShDegree): number => (degree + 1) ** 2 - 1;
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Shape check at the ownership boundary; values were validated by normalizeGaussianAttributes. */
export function validateGaussianAttributes(attributes: NormalizedGaussianAttributes): void {
  const { count, sphericalHarmonicsDegree: degree } = attributes;
  const rows = (array: Float32Array, stride: number) => array instanceof Float32Array && array.length === count * stride;
  const valid = Number.isSafeInteger(count) && count > 0 && [0, 1, 2, 3].includes(degree)
    && rows(attributes.positions, 3) && rows(attributes.scales, 3) && rows(attributes.rotations, 4)
    && rows(attributes.colors, 4) && rows(attributes.opacities, 1)
    && rows(attributes.sphericalHarmonics, shBasisCount(degree) * 3);
  if (!valid) throw new GaussianSplatError('invalid-attributes', 'Gaussian attributes must be non-empty normalizeGaussianAttributes output.');
}

/**
 * Highest band holding a non-zero coefficient. Packing at this degree is exact:
 * dropped bands contribute exactly zero radiance in upstream's evaluation.
 */
export function effectiveShDegree(attributes: NormalizedGaussianAttributes): ShDegree {
  const basis = shBasisCount(attributes.sphericalHarmonicsDegree);
  let highest = 0;
  for (let row = 0; row < attributes.count && highest < attributes.sphericalHarmonicsDegree; row++) {
    for (let index = highest === 0 ? 0 : (highest + 1) ** 2 - 1; index < basis; index++) {
      const base = (row * basis + index) * 3;
      const sh = attributes.sphericalHarmonics;
      if (sh[base] !== 0 || sh[base + 1] !== 0 || sh[base + 2] !== 0) highest = Math.max(highest, Math.floor(Math.sqrt(index + 1)));
    }
  }
  return highest as ShDegree;
}

/** Reject a packed size the device cannot bind, before any allocation. */
export function assertPackedBudget(rows: number, degree: ShDegree, limits: Pick<GPUSupportedLimits, 'maxStorageBufferBindingSize' | 'maxBufferSize'> | null): void {
  const largest = Math.max(rows * 16, rows * shBasisCount(degree) * 3 * 4);
  const cap = limits ? Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) : Infinity;
  if (rows > MAX_GAUSSIAN_PACKED_ROWS || largest > cap) {
    throw new GaussianSplatError('resource-limit', `${rows} Gaussians at SH degree ${degree} need a ${largest}-byte binding; the device allows ${cap}.`);
  }
}

/** Fold the scene model translation into the placement, in float64. */
export function placeInWorld(placement: SimilarityPlacement, translation: readonly [number, number, number] | undefined): SimilarityPlacement {
  if (!translation) return placement;
  const [x, y, z] = placement.translation;
  return { ...placement, translation: [x + translation[0], y + translation[1], z + translation[2]] };
}

function allocate(rows: number, degree: ShDegree): GaussianPackedSource {
  return {
    positions: new Float32Array(rows * 3), scales: new Float32Array(rows * 3), rotations: new Float32Array(rows * 4),
    colors: new Float32Array(rows * 4), opacities: new Float32Array(rows), semanticIds: new Uint32Array(rows),
    ...(degree > 0 ? { sphericalHarmonics: new Float32Array(rows * shBasisCount(degree) * 3) } : {}),
    sphericalHarmonicsDegree: degree,
  };
}

/** Transform one asset's rows into `target` rows starting at `offset`; returns centre bounds. */
async function transformInto(
  attributes: NormalizedGaussianAttributes, placement: SimilarityPlacement, anchor: readonly [number, number, number],
  target: Omit<GaussianPackedSource, 'colors' | 'opacities' | 'semanticIds'>, offset: number, checkpoint: Checkpoint,
): Promise<GaussianSplatBounds> {
  const degree = Math.min(attributes.sphericalHarmonicsDegree, target.sphericalHarmonicsDegree) as ShDegree;
  const rotation = shRotationFor(placement, degree);
  const rowTarget = { ...target, shBasisCount: shBasisCount(target.sphericalHarmonicsDegree) };
  const source = degree === attributes.sphericalHarmonicsDegree ? attributes : truncateSh(attributes, degree);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let start = 0; start < attributes.count; start += CHUNK_ROWS) {
    checkpoint();
    const end = Math.min(attributes.count, start + CHUNK_ROWS);
    transformGaussianRows(source, placement, rotation, anchor, rowTarget, offset, start, end);
    for (let row = offset + start; row < offset + end; row++) {
      for (let axis = 0; axis < 3; axis++) {
        const local = target.positions[row * 3 + axis];
        if (!(Math.abs(local) <= MAX_GAUSSIAN_ANCHOR_EXTENT_METRES)) {
          throw Number.isFinite(local)
            ? new GaussianSplatError('anchor-extent', `A Gaussian centre lies ${Math.abs(local)} m from the shared anchor (limit ${MAX_GAUSSIAN_ANCHOR_EXTENT_METRES} m).`)
            : new GaussianSplatError('invalid-attributes', 'A placed Gaussian centre is not finite.');
        }
        min[axis] = Math.min(min[axis], local);
        max[axis] = Math.max(max[axis], local);
      }
    }
    await yieldTurn();
  }
  checkpoint();
  return { min: [min[0] + anchor[0], min[1] + anchor[1], min[2] + anchor[2]], max: [max[0] + anchor[0], max[1] + anchor[1], max[2] + anchor[2]] };
}

/** Coefficients above `degree` are exactly zero (see effectiveShDegree); drop them for packing. */
function truncateSh(attributes: NormalizedGaussianAttributes, degree: ShDegree): NormalizedGaussianAttributes {
  const from = shBasisCount(attributes.sphericalHarmonicsDegree);
  const to = shBasisCount(degree);
  const sphericalHarmonics = new Float32Array(attributes.count * to * 3);
  for (let row = 0; row < attributes.count; row++) {
    sphericalHarmonics.set(attributes.sphericalHarmonics.subarray(row * from * 3, row * from * 3 + to * 3), row * to * 3);
  }
  return { ...attributes, sphericalHarmonics, sphericalHarmonicsDegree: degree };
}

/** Copy kept slices into a new source (re-laying SH bands), then append and transform `added`. */
export async function buildPacked(
  previous: PackedScene | null,
  keep: readonly number[],
  added: { slot: number; attributes: NormalizedGaussianAttributes; placement: SimilarityPlacement; degree: ShDegree } | null,
  anchor: readonly [number, number, number],
  degree: ShDegree,
  checkpoint: Checkpoint,
): Promise<{ scene: PackedScene; addedBounds: GaussianSplatBounds | null }> {
  const keptRows = keep.reduce((sum, slot) => sum + (previous?.slices.get(slot)?.rows ?? 0), 0);
  const source = allocate(keptRows + (added?.attributes.count ?? 0), degree);
  const slices = new Map<number, PackedSlice>();
  let offset = 0;
  const toBasis = shBasisCount(degree);
  for (const slot of keep) {
    const slice = previous?.slices.get(slot);
    if (!previous || !slice) continue;
    checkpoint();
    const from = previous.source;
    const span = (stride: number) => [slice.offset * stride, (slice.offset + slice.rows) * stride] as const;
    source.positions.set(from.positions.subarray(...span(3)), offset * 3);
    source.scales.set(from.scales.subarray(...span(3)), offset * 3);
    source.rotations.set(from.rotations.subarray(...span(4)), offset * 4);
    source.colors.set(from.colors.subarray(...span(4)), offset * 4);
    source.opacities.set(from.opacities.subarray(...span(1)), offset);
    source.semanticIds.fill(slot, offset, offset + slice.rows);
    const fromBasis = shBasisCount(from.sphericalHarmonicsDegree);
    const copied = Math.min(fromBasis, toBasis) * 3;
    if (copied > 0 && from.sphericalHarmonics && source.sphericalHarmonics) {
      for (let row = 0; row < slice.rows; row++) {
        const fromStart = (slice.offset + row) * fromBasis * 3;
        source.sphericalHarmonics.set(from.sphericalHarmonics.subarray(fromStart, fromStart + copied), (offset + row) * toBasis * 3);
      }
    }
    slices.set(slot, { offset, rows: slice.rows });
    offset += slice.rows;
    await yieldTurn();
  }
  let addedBounds: GaussianSplatBounds | null = null;
  if (added) {
    const { attributes } = added;
    source.colors.set(attributes.colors, offset * 4);
    source.opacities.set(attributes.opacities, offset);
    source.semanticIds.fill(added.slot, offset, offset + attributes.count);
    const reduced = added.degree === attributes.sphericalHarmonicsDegree ? attributes : truncateSh(attributes, added.degree);
    addedBounds = await transformInto(reduced, added.placement, anchor, source, offset, checkpoint);
    slices.set(added.slot, { offset, rows: attributes.count });
  }
  return { scene: { source, slices }, addedBounds };
}

/** A fresh, slice-sized re-placement of one asset; nothing is written into the packed source. */
export async function transformSlice(
  attributes: NormalizedGaussianAttributes, placement: SimilarityPlacement, anchor: readonly [number, number, number],
  degree: ShDegree, checkpoint: Checkpoint,
): Promise<SliceRows> {
  const target = allocate(attributes.count, degree);
  const source = degree < attributes.sphericalHarmonicsDegree ? truncateSh(attributes, degree) : attributes;
  const bounds = await transformInto(source, placement, anchor, target, 0, checkpoint);
  return { positions: target.positions, scales: target.scales, rotations: target.rotations, sphericalHarmonics: target.sphericalHarmonics, bounds };
}
