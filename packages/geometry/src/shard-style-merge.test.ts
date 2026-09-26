/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { mergeShardStyleSlices, type StylesSlice } from './shard-style-merge.js';

function slice(geomIds: number[], geomFinishes?: number[]): StylesSlice {
  return {
    orphanIds: new Uint32Array(0), orphanColors: new Float32Array(0),
    geomIds: new Uint32Array(geomIds),
    // Colour lane 0 carries the id so a mis-paired colour is visible too.
    geomColors: new Float32Array(geomIds.flatMap((id) => [id, 0, 0, 1])),
    ...(geomFinishes ? { geomFinishes: new Float32Array(geomFinishes) } : {}),
  };
}

describe('mergeShardStyleSlices (#5582 finishes)', () => {
  it('takes each id\'s finish from the slice that won its colour, empty claims included', () => {
    const merged = mergeShardStyleSlices([
      slice([10, 11], [NaN, NaN, 0, 0.25]),
      null,
      slice([10, 20], [1, 0.5, NaN, 0.75]),
    ]);
    expect(Array.from(merged.geomIds)).toEqual([10, 11, 20]);
    expect(Array.from(merged.geomColors)).toEqual([10, 0, 0, 1, 11, 0, 0, 1, 20, 0, 0, 1]);
    // #10: slice 0 claimed it with no finish; slice 1's [1, 0.5] must not leak in.
    expect(Array.from(merged.geomFinishes)).toEqual([NaN, NaN, 0, 0.25, NaN, 0.75]);
  });

  it('leaves NaN for a slice from an older wasm with no finish column, or a short one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeShardStyleSlices([slice([10]), slice([20, 30], [0.5, 0.5, 1])]);
    expect(Array.from(merged.geomIds)).toEqual([10, 20, 30]);
    expect(Array.from(merged.geomFinishes)).toEqual([NaN, NaN, 0.5, 0.5, NaN, NaN]);
  });
});
