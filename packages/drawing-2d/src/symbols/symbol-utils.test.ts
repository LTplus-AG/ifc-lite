/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { inferWallDirection } from './symbol-utils.js';
import type { Bounds2D } from '../types.js';

describe('inferWallDirection', () => {
  it('returns horizontal direction when width exceeds height', () => {
    const bounds: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 4, y: 1 } };
    expect(inferWallDirection(bounds)).toEqual({ x: 1, y: 0 });
  });

  it('returns vertical direction when height exceeds width', () => {
    const bounds: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 1, y: 4 } };
    expect(inferWallDirection(bounds)).toEqual({ x: 0, y: 1 });
  });

  it('returns vertical direction for a square opening (width === height boundary)', () => {
    const bounds: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 2, y: 2 } };
    expect(inferWallDirection(bounds)).toEqual({ x: 0, y: 1 });
  });
});
