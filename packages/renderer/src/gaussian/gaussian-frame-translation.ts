/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SimilarityPlacement } from './gaussian-placement.js';
import type { GaussianSplatBounds } from './gaussian-types.js';
import { GaussianSplatError } from './gaussian-errors.js';

interface FrameAsset {
  committed: SimilarityPlacement;
  requested: SimilarityPlacement;
  bounds: GaussianSplatBounds;
}

/** Move the WHOLE render frame, including its f64 anchor. Packed f32 locals
 * stay identical, so this never enlarges or relaxes the precision envelope. */
export function translateGaussianFrame(assets: Iterable<FrameAsset>, anchor: readonly number[], delta: readonly number[]): [number, number, number] {
  if (delta.length !== 3 || !delta.every(Number.isFinite)) throw new GaussianSplatError('invalid-placement', 'A frame translation needs three finite values.');
  const shift = (p: readonly number[]): [number, number, number] => [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
  const records = [...assets];
  const moved = records.map(record => ({
    committed: { ...record.committed, translation: shift(record.committed.translation) },
    requested: { ...record.requested, translation: shift(record.requested.translation) },
    bounds: { min: shift(record.bounds.min), max: shift(record.bounds.max) },
  }));
  const next = shift(anchor);
  if (![...next, ...moved.flatMap(r => [...r.committed.translation, ...r.requested.translation, ...r.bounds.min, ...r.bounds.max])].every(Number.isFinite)) {
    throw new GaussianSplatError('invalid-placement', 'A frame translation overflowed.');
  }
  records.forEach((record, i) => Object.assign(record, moved[i]));
  return next;
}
