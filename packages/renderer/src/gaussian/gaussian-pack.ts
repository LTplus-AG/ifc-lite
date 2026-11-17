/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packing every Gaussian asset into the single upstream source (#8564), without a
 * CPU copy of the packed rows (#9018). Each asset either keeps its rows by a GPU
 * copy from the drawn data or is read again from its `GaussianRowSource`, placed
 * in bounded staging chunks and written straight to the new GPU allocation. The
 * only CPU rows retained are the sort columns. `checkpoint` runs between chunks
 * and throws to abandon the build; the backend then releases the allocation.
 */

import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';
import type { GaussianGpuRows, GaussianPackedLayout, GaussianRowWriter, GaussianSortColumns } from './gaussian-backend.js';
import { GaussianSplatError } from './gaussian-errors.js';
import { shRotationFor, transformGaussianRows, type SimilarityPlacement } from './gaussian-placement.js';
import type { GaussianRowSource, GaussianShDegree } from './gaussian-rows.js';
import type { GaussianSplatBounds } from './gaussian-types.js';

/** Same envelope as the mesh RTE contract's MAX_RTE_LOCAL_METRES: sub-millimetre f32 locals. */
export const MAX_GAUSSIAN_ANCHOR_EXTENT_METRES = 8_192;
/** Rows past this are rejected before allocation; GPU binding limits usually bind first. */
export const MAX_GAUSSIAN_PACKED_ROWS = 1 << 24;
/**
 * Staging rows per GPU write; even, so float16x2 coefficient words never straddle two writes.
 * Small on purpose: the staging set is garbage after each repack, and the retained-memory
 * budget is sampled before the browser collects it (#9018).
 */
export const STAGING_ROWS = 8_192;
/** Largest |coefficient| a float16 holds (65504), divided by the worst band-rotation growth, sqrt(7). */
const MAX_HALF_SH_SOURCE = 65_504 / Math.sqrt(7);

export type ShDegree = GaussianShDegree;
export type Checkpoint = () => void;
export interface PackedSlice { readonly offset: number; readonly rows: number }
/** What the layer remembers of the drawn data: its layout, sort columns and per-asset rows. */
export interface PackedScene {
  readonly layout: GaussianPackedLayout;
  readonly sort: GaussianSortColumns;
  readonly slices: ReadonlyMap<number, PackedSlice>;
}

/** One asset of a new pack: GPU-copied from `previous`, or read from its source at `placement`. */
export type PackEntry =
  | { readonly slot: number; readonly kind: 'copy'; readonly rows: number }
  | { readonly slot: number; readonly kind: 'read'; readonly source: GaussianRowSource; readonly placement: SimilarityPlacement };

export const shBasisCount = (degree: ShDegree): number => (degree + 1) ** 2 - 1;
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const even = (row: number) => row + (row & 1);

/** Float16 coefficients whenever every rotated coefficient stays finite in half precision (lossless for real captures to well under 1/2 of an 8-bit step; see #9018). */
export function shEncodingFor(sources: readonly GaussianRowSource[], degree: ShDegree): GaussianPackedLayout['shEncoding'] {
  return degree > 0 && sources.every((source) => source.maxAbsShCoefficient < MAX_HALF_SH_SOURCE) ? 'float16x2' : 'float32';
}

/** 32-bit words of SH storage for `rows` packed rows. */
export function shWords(layout: Pick<GaussianPackedLayout, 'rows' | 'shDegree' | 'shEncoding'>): number {
  const coefficients = layout.rows * shBasisCount(layout.shDegree) * 3;
  return layout.shEncoding === 'float16x2' ? Math.ceil(coefficients / 2) : coefficients;
}

/** Row offsets: every asset starts on an even row, padding rows (slot 0, opacity 0) fill the gaps. */
export function layoutSlices(entries: readonly { slot: number; rows: number }[]): { rows: number; slices: Map<number, PackedSlice> } {
  const slices = new Map<number, PackedSlice>();
  let offset = 0;
  for (const entry of entries) {
    offset = even(offset);
    slices.set(entry.slot, { offset, rows: entry.rows });
    offset += entry.rows;
  }
  return { rows: offset, slices };
}

/** Reject a packed size the device cannot bind, before any allocation. */
export function assertPackedBudget(layout: GaussianPackedLayout, limits: Pick<GPUSupportedLimits, 'maxStorageBufferBindingSize' | 'maxBufferSize'> | null): void {
  const largest = Math.max(layout.rows * 16, shWords(layout) * 4);
  const cap = limits ? Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) : Infinity;
  if (layout.rows > MAX_GAUSSIAN_PACKED_ROWS || largest > cap) {
    throw new GaussianSplatError('resource-limit', `${layout.rows} Gaussians at SH degree ${layout.shDegree} need a ${largest}-byte binding; the device allows ${cap}.`);
  }
}

/** Fold the scene model translation into the placement, in float64. */
export function placeInWorld(placement: SimilarityPlacement, translation: readonly [number, number, number] | undefined): SimilarityPlacement {
  if (!translation) return placement;
  const [x, y, z] = placement.translation;
  return { ...placement, translation: [x + translation[0], y + translation[1], z + translation[2]] };
}

/**
 * Fill `writer` with `entries` laid out by `slices`. `previous` supplies the sort
 * columns of copied assets (their GPU rows are copied by the backend). Returns the
 * new sort columns and the centre bounds of every read asset.
 */
export async function fillPacked(
  writer: GaussianRowWriter, layout: GaussianPackedLayout, slices: ReadonlyMap<number, PackedSlice>, entries: readonly PackEntry[],
  previous: PackedScene | null, anchor: readonly [number, number, number], checkpoint: Checkpoint,
): Promise<{ sort: GaussianSortColumns; bounds: Map<number, GaussianSplatBounds> }> {
  const sort: GaussianSortColumns = { positions: new Float32Array(layout.rows * 3), opacities: new Float32Array(layout.rows), semanticIds: new Uint32Array(layout.rows) };
  const bounds = new Map<number, GaussianSplatBounds>();
  let staging: Staging | null = null;
  for (const entry of entries) {
    checkpoint();
    const slice = slices.get(entry.slot)!;
    if (entry.kind === 'copy') {
      const from = previous?.slices.get(entry.slot);
      if (!previous || !from || from.rows !== slice.rows) throw new RangeError(`Gaussian slot ${entry.slot} has no rows to copy`);
      writer.copy(from.offset, slice.offset, slice.rows);
      sort.positions.set(previous.sort.positions.subarray(from.offset * 3, (from.offset + from.rows) * 3), slice.offset * 3);
      sort.opacities.set(previous.sort.opacities.subarray(from.offset, from.offset + from.rows), slice.offset);
      sort.semanticIds.fill(entry.slot, slice.offset, slice.offset + slice.rows);
      continue;
    }
    if (entry.source.count !== slice.rows) throw new RangeError(`Gaussian slot ${entry.slot} source changed its row count`);
    staging ??= createStaging(layout);
    bounds.set(entry.slot, await readInto(writer, staging, layout, slice, entry, sort, anchor, checkpoint));
  }
  checkpoint();
  return { sort, bounds };
}

/** Centre bounds of `source` placed at `placement` (validating the anchor envelope), without any GPU upload. */
export async function placedBounds(
  source: GaussianRowSource, placement: SimilarityPlacement, anchor: readonly [number, number, number], shDegree: ShDegree, checkpoint: Checkpoint,
): Promise<GaussianSplatBounds> {
  const layout: GaussianPackedLayout = { rows: source.count, shDegree, shEncoding: 'float32' };
  const sort: GaussianSortColumns = { positions: new Float32Array(source.count * 3), opacities: new Float32Array(source.count), semanticIds: new Uint32Array(source.count) };
  const discard: GaussianRowWriter = { write() {}, copy() {} };
  return readInto(discard, createStaging(layout), layout, { offset: 0, rows: source.count }, { slot: 0, kind: 'read', source, placement }, sort, anchor, checkpoint);
}

interface Staging extends Omit<GaussianGpuRows, 'sphericalHarmonics'> {
  readonly sphericalHarmonics?: Float32Array;
  readonly halves?: Uint32Array;
}

function createStaging(layout: GaussianPackedLayout): Staging {
  const basis = shBasisCount(layout.shDegree);
  return {
    positions: new Float32Array(STAGING_ROWS * 3), scales: new Float32Array(STAGING_ROWS * 3), rotations: new Float32Array(STAGING_ROWS * 4),
    colors: new Float32Array(STAGING_ROWS * 4), opacities: new Float32Array(STAGING_ROWS), semanticIds: new Uint32Array(STAGING_ROWS),
    ...(basis > 0 ? { sphericalHarmonics: new Float32Array(STAGING_ROWS * basis * 3) } : {}),
    ...(basis > 0 && layout.shEncoding === 'float16x2' ? { halves: new Uint32Array(Math.ceil((STAGING_ROWS * basis * 3) / 2)) } : {}),
  };
}

/** Stream one source into its slice through the staging chunk; returns centre bounds in world coordinates. */
async function readInto(
  writer: GaussianRowWriter, staging: Staging, layout: GaussianPackedLayout, slice: PackedSlice,
  entry: Extract<PackEntry, { kind: 'read' }>, sort: GaussianSortColumns, anchor: readonly [number, number, number], checkpoint: Checkpoint,
): Promise<GaussianSplatBounds> {
  const degree = Math.min(entry.source.effectiveShDegree, layout.shDegree) as ShDegree;
  const rotation = shRotationFor(entry.placement, degree);
  const target = { ...staging, shBasisCount: shBasisCount(layout.shDegree) };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let filled = 0; // rows staged, not yet written
  let written = 0; // rows of the slice already written
  let expected = 0;
  const flush = () => {
    if (filled === 0) return;
    const row = slice.offset + written;
    sort.positions.set(staging.positions.subarray(0, filled * 3), row * 3);
    sort.opacities.set(staging.opacities.subarray(0, filled), row);
    sort.semanticIds.fill(entry.slot, row, row + filled);
    staging.semanticIds.fill(entry.slot, 0, filled);
    writer.write(row, {
      positions: staging.positions.subarray(0, filled * 3), scales: staging.scales.subarray(0, filled * 3),
      rotations: staging.rotations.subarray(0, filled * 4), colors: staging.colors.subarray(0, filled * 4),
      opacities: staging.opacities.subarray(0, filled), semanticIds: staging.semanticIds.subarray(0, filled),
      ...(staging.sphericalHarmonics ? { sphericalHarmonics: shChunk(staging, filled, target.shBasisCount) } : {}),
    });
    written += filled;
    filled = 0;
  };
  await entry.source.read(async (raw, rowStart) => {
    checkpoint();
    if (rowStart !== expected || raw.count < 1 || rowStart + raw.count > slice.rows || raw.sphericalHarmonicsDegree !== entry.source.sphericalHarmonicsDegree) {
      throw new GaussianSplatError('invalid-attributes', 'A Gaussian row source delivered rows out of order or of another shape.');
    }
    expected += raw.count;
    const chunk = raw.sphericalHarmonicsDegree > degree ? truncateSh(raw, degree) : raw;
    for (let start = 0; start < chunk.count;) {
      const take = Math.min(chunk.count - start, STAGING_ROWS - filled);
      transformGaussianRows(rowsView(chunk, start, start + take), entry.placement, rotation, anchor, target, filled, 0, take);
      staging.colors.set(chunk.colors.subarray(start * 4, (start + take) * 4), filled * 4);
      staging.opacities.set(chunk.opacities.subarray(start, start + take), filled);
      for (let row = filled; row < filled + take; row++) {
        for (let axis = 0; axis < 3; axis++) {
          const local = staging.positions[row * 3 + axis];
          if (!(Math.abs(local) <= MAX_GAUSSIAN_ANCHOR_EXTENT_METRES)) { // placement already rejects non-finite results
            throw new GaussianSplatError('anchor-extent', `A Gaussian centre lies ${Math.abs(local)} m from the shared anchor (limit ${MAX_GAUSSIAN_ANCHOR_EXTENT_METRES} m).`);
          }
          min[axis] = Math.min(min[axis], local);
          max[axis] = Math.max(max[axis], local);
        }
      }
      filled += take;
      start += take;
      if (filled === STAGING_ROWS) { flush(); await yieldTurn(); checkpoint(); }
    }
  });
  if (expected !== slice.rows) throw new GaussianSplatError('invalid-attributes', 'A Gaussian row source ended early.');
  flush();
  checkpoint();
  return { min: [min[0] + anchor[0], min[1] + anchor[1], min[2] + anchor[2]], max: [max[0] + anchor[0], max[1] + anchor[1], max[2] + anchor[2]] };
}

/** Coefficient words of the first `rows` staged rows; float16x2 rounds to nearest even. */
function shChunk(staging: Staging, rows: number, basis: number): Float32Array | Uint32Array {
  const coefficients = rows * basis * 3;
  const source = staging.sphericalHarmonics!;
  if (!staging.halves) return source.subarray(0, coefficients);
  const words = Math.ceil(coefficients / 2);
  for (let word = 0; word < words; word++) {
    const index = word * 2;
    const high = index + 1 < coefficients ? halfBits(source[index + 1]) : 0;
    staging.halves[word] = (halfBits(source[index]) | (high << 16)) >>> 0;
  }
  return staging.halves.subarray(0, words);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** IEEE binary16 bits of a float32, round to nearest even (the input is finite and below 65504). */
export function halfBits(value: number): number {
  f32[0] = value;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent >= 143) return sign | 0x7c00; // overflow (excluded by shEncodingFor)
  if (exponent >= 113) { // normal half
    let half = ((exponent - 112) << 10) | (mantissa >>> 13);
    const rest = mantissa & 0x1fff;
    if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++;
    return sign | half;
  }
  if (exponent < 102) return sign; // below half the smallest subnormal
  mantissa |= 0x800000;
  const shift = 126 - exponent;
  let half = mantissa >>> shift;
  const rest = mantissa & ((1 << shift) - 1);
  const halfway = 1 << (shift - 1);
  if (rest > halfway || (rest === halfway && (half & 1))) half++;
  return sign | half;
}

/** Rows [start, end) of `rows` as views. */
function rowsView(rows: NormalizedGaussianAttributes, start: number, end: number): NormalizedGaussianAttributes {
  if (start === 0 && end === rows.count) return rows;
  const basis = shBasisCount(rows.sphericalHarmonicsDegree) * 3;
  return {
    ...rows, count: end - start,
    positions: rows.positions.subarray(start * 3, end * 3), scales: rows.scales.subarray(start * 3, end * 3),
    rotations: rows.rotations.subarray(start * 4, end * 4), colors: rows.colors.subarray(start * 4, end * 4),
    opacities: rows.opacities.subarray(start, end), sphericalHarmonics: rows.sphericalHarmonics.subarray(start * basis, end * basis),
  };
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
