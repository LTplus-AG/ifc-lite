/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapZupChunkToYup } from './pointCloudFrame.js';
import type { DecodedPointChunk } from '@ifc-lite/pointcloud';

test('Z-up ingest rotates source normals with positions without mutating the decoder arrays (#4561)', () => {
  const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
  const normals = new Float32Array([0.1, 0.2, 0.3, -0.4, -0.5, -0.6]);
  const chunk: DecodedPointChunk = { positions, normals, pointCount: 2, bbox: { min: [1, 2, 3], max: [4, 5, 6] } };
  const yUp = swapZupChunkToYup(chunk);
  assert.deepEqual(Array.from(yUp.positions), [1, 3, -2, 4, 6, -5]);
  assert.deepEqual(Array.from(yUp.normals!), [0.1, 0.3, -0.2, -0.4, -0.6, 0.5].map(Math.fround));
  assert.deepEqual(Array.from(positions), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(normals), [0.1, 0.2, 0.3, -0.4, -0.5, -0.6].map(Math.fround));
  assert.deepEqual(yUp.bbox, { min: [1, 3, -5], max: [4, 6, -2] });
});
