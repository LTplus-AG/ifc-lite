/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSortedSplatIndicesByDepth } from '@luma.gl/splats';
import { captures, defaultAssets, verifyBytes } from '../prepare.mjs';
import { decodeCaptureBytes, captureColumns } from '../decode.mjs';
// #8140: depth comparison alone cannot adapt a renderer whose sorting uses
// projected depth in the conventional descending order to reverse-Z.
test('upstream sort direction exposes the reverse-Z integration blocker (#8140)', () => {
  const near = 0.1;
  const projectedDepths = new Float32Array([near / 2, near / 10]);
  assert.deepEqual(Array.from(getSortedSplatIndicesByDepth(projectedDepths)), [0, 1]);
  // Correct alpha compositing requires the far splat first; this proves
  // that upstream's unchanged comparator needs an adaptation.
  assert.notDeepEqual(Array.from(getSortedSplatIndicesByDepth(projectedDepths)), [1, 0]);
});
for (const capture of captures) test(`real ${capture.id} decodes through upstream with finite Gaussian channels (#8140)`, async t => {
  let bytes;
  try { bytes = await readFile(join(process.env.SPLAT_SPIKE_ASSETS ?? defaultAssets, `${capture.id}.splat`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('Run node examples/gaussian-splat-spike/prepare.mjs to fetch optional fixtures.'); return; }
  verifyBytes(bytes, capture);
  const data = await decodeCaptureBytes(bytes);
  assert.equal(data.numSplats, capture.count);
  const columns = captureColumns(data, [0, 0, 0]);
  assert.equal(columns.positions.length, capture.count * 3);
  assert.ok(columns.positions.every(Number.isFinite));
  assert.ok(columns.scales.every(value => Number.isFinite(value) && value > 0));
  assert.ok(columns.opacities.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(columns.colors.some(value => value > 0 && value < 255));
  for (let i = 0; i < columns.rotations.length; i += 4) {
    const q = columns.rotations.subarray(i, i + 4);
    const norm = Math.hypot(...q);
    assert.ok(Math.abs(norm - 1) < 0.02, `quaternion norm ${norm}`);
  }
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 1;
  assert.throws(() => verifyBytes(corrupted, capture), /integrity/);
});
