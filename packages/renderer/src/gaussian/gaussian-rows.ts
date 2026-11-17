/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The canonical rows of one Gaussian asset (#9018). The renderer never keeps a
 * full CPU copy of an asset: every upload (add, re-placement, a repack with a new
 * SH layout, device recovery) reads the rows again from this source, in bounded
 * chunks, and writes them straight to GPU buffers. The viewer backs it with the
 * capture file (decoded again in a worker); `gaussianRowsFromAttributes` backs it
 * with arrays the caller already holds.
 */

import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';
import { GaussianSplatError } from './gaussian-errors.js';

export type GaussianShDegree = 0 | 1 | 2 | 3;

export interface GaussianRowSource {
  readonly count: number;
  /** Degree of the coefficient rows each chunk carries. */
  readonly sphericalHarmonicsDegree: GaussianShDegree;
  /** Highest band holding a non-zero coefficient; packing at it is exact. */
  readonly effectiveShDegree: GaussianShDegree;
  /** Largest |SH coefficient| over all rows; decides the GPU coefficient encoding before any upload. */
  readonly maxAbsShCoefficient: number;
  /**
   * The rows must not change while the asset exists: the SH degrees and coefficient
   * range above are decided once, and every re-read must deliver the same values.
   *
   * Visit every row once, in order, as normalized source-local chunks (`rowStart`
   * counts from 0). Chunks may be views; the visitor copies what it keeps. Each
   * call reads afresh, so it may be repeated. Rejects when `signal` aborts.
   */
  read(visit: (chunk: NormalizedGaussianAttributes, rowStart: number) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
}

const VIEW_ROWS = 65_536;

/** A row source over arrays the caller keeps alive and unmodified; chunks are views, nothing is copied. */
export function gaussianRowsFromAttributes(attributes: NormalizedGaussianAttributes): GaussianRowSource {
  const { count, sphericalHarmonicsDegree: degree } = attributes;
  const basis = (degree + 1) ** 2 - 1;
  return {
    count,
    sphericalHarmonicsDegree: degree,
    effectiveShDegree: effectiveShDegree(attributes),
    maxAbsShCoefficient: attributes.sphericalHarmonics.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    async read(visit, signal) {
      for (let start = 0; start < count; start += VIEW_ROWS) {
        signal?.throwIfAborted();
        const end = Math.min(count, start + VIEW_ROWS);
        const view = <T extends Float32Array>(array: T, stride: number) => array.subarray(start * stride, end * stride) as T;
        await visit({
          count: end - start, positions: view(attributes.positions, 3), scales: view(attributes.scales, 3),
          rotations: view(attributes.rotations, 4), colors: view(attributes.colors, 4), opacities: view(attributes.opacities, 1),
          sphericalHarmonics: view(attributes.sphericalHarmonics, basis * 3), sphericalHarmonicsDegree: degree,
        }, start);
      }
      signal?.throwIfAborted();
    },
  };
}

/**
 * Highest band holding a non-zero coefficient. Packing at this degree is exact:
 * dropped bands contribute exactly zero radiance in upstream's evaluation.
 */
export function effectiveShDegree(attributes: NormalizedGaussianAttributes): GaussianShDegree {
  const basis = (attributes.sphericalHarmonicsDegree + 1) ** 2 - 1;
  let highest = 0;
  for (let row = 0; row < attributes.count && highest < attributes.sphericalHarmonicsDegree; row++) {
    for (let index = highest === 0 ? 0 : (highest + 1) ** 2 - 1; index < basis; index++) {
      const base = (row * basis + index) * 3;
      const sh = attributes.sphericalHarmonics;
      if (sh[base] !== 0 || sh[base + 1] !== 0 || sh[base + 2] !== 0) highest = Math.max(highest, Math.floor(Math.sqrt(index + 1)));
    }
  }
  return highest as GaussianShDegree;
}

/** Shape check at the ownership boundary; values were validated by normalizeGaussianAttributes. */
export function validateGaussianAttributes(attributes: NormalizedGaussianAttributes): void {
  const { count, sphericalHarmonicsDegree: degree } = attributes;
  const rows = (array: Float32Array, stride: number) => array instanceof Float32Array && array.length === count * stride;
  const valid = Number.isSafeInteger(count) && count > 0 && [0, 1, 2, 3].includes(degree)
    && rows(attributes.positions, 3) && rows(attributes.scales, 3) && rows(attributes.rotations, 4)
    && rows(attributes.colors, 4) && rows(attributes.opacities, 1)
    && rows(attributes.sphericalHarmonics, ((degree + 1) ** 2 - 1) * 3);
  if (!valid) throw new GaussianSplatError('invalid-attributes', 'Gaussian attributes must be non-empty normalizeGaussianAttributes output.');
}

/** Shape check of a caller's row source; its chunks are checked again while they are read. */
export function validateGaussianRows(rows: GaussianRowSource): void {
  const degree = (value: unknown) => value === 0 || value === 1 || value === 2 || value === 3;
  const valid = Number.isSafeInteger(rows.count) && rows.count > 0 && degree(rows.sphericalHarmonicsDegree) && degree(rows.effectiveShDegree)
    && rows.effectiveShDegree <= rows.sphericalHarmonicsDegree && Number.isFinite(rows.maxAbsShCoefficient) && rows.maxAbsShCoefficient >= 0
    && typeof rows.read === 'function';
  if (!valid) throw new GaussianSplatError('invalid-attributes', 'A Gaussian row source must state a positive count, its SH degrees, its largest coefficient and read().');
}

/** The canonical rows of an `add` input, validated at the ownership boundary. */
export function gaussianAssetRows(input: { readonly rows: GaussianRowSource } | { readonly attributes: NormalizedGaussianAttributes }): GaussianRowSource {
  if ('rows' in input) { validateGaussianRows(input.rows); return input.rows; }
  validateGaussianAttributes(input.attributes);
  return gaussianRowsFromAttributes(input.attributes);
}
