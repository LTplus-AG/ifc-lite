/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { chunkFromWire, chunkToWire } from './protocol.js';
import type { DecodedPointChunk } from '../types.js';

describe('decode worker normal channel (#4561)', () => {
  it('transfers and reconstructs normals without disturbing row order', () => {
    const chunk: DecodedPointChunk = { positions: new Float32Array([1, 2, 3, 4, 5, 6]), colors: new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5]),
      normals: new Float32Array([0, 0, 1, 1, 0, 0]), pointCount: 2, bbox: { min: [1, 2, 3], max: [4, 5, 6] } };
    const { payload, transfer } = chunkToWire(chunk);
    expect(transfer).toContain(payload.normals);
    const decoded = chunkFromWire(payload);
    expect(Array.from(decoded.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(decoded.normals!)).toEqual([0, 0, 1, 1, 0, 0]);
  });
});
