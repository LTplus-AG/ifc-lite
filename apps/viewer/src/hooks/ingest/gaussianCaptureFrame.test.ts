// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaussianCaptureFrame } from './gaussianCaptureFrame.js';
import { swapZupChunkToYup } from './pointCloudFrame.js';

const point = (m: readonly number[], p: number[]) => [0, 1, 2].map(r => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12]);

test('capture default matches actual point-cloud ingest, Y-up override preserves source (#8752)', () => {
  const p = [1, 2, 3];
  const scan = swapZupChunkToYup({ positions: new Float32Array(p), pointCount: 1, bbox: { min: [1, 2, 3], max: [1, 2, 3] } });
  assert.deepEqual(point(gaussianCaptureFrame().placement, p), [1, 3, -2]);
  assert.deepEqual(point(gaussianCaptureFrame().placement, p), [...scan.positions]);
  assert.deepEqual(point(gaussianCaptureFrame(undefined, 'y').placement, p), p);
});

test('source rotation precedes caller placement, and IFC origin/RTC subtraction comes last (#8752)', () => {
  // IFC world near Swiss survey coordinates; RTC is Z-up, originShift Y-up.
  const frame = { originShift: { x: 10, y: 20, z: 30 }, wasmRtcOffset: { x: 2_600_000, y: 1_200_000, z: 500 } };
  // A caller translation and scale deliberately do not commute with rotation/offset.
  const caller = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 8, 12, 16, 1];
  const p = [1_300_004, 600_000, 250];
  assert.deepEqual(point(gaussianCaptureFrame(caller, 'z', frame).placement, p), [6, -8, -14]);
  assert.deepEqual(point(gaussianCaptureFrame(undefined, 'z', frame).placement, [2_600_012, 1_200_003, 524]), [2, 4, -33]);
});

test('explicit historical axis mapping is respected, invalid placement refuses (#8752)', () => {
  const rx180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  assert.deepEqual(point(gaussianCaptureFrame(rx180).placement, [1, 2, 3]), [1, -2, -3]);
  assert.throws(() => gaussianCaptureFrame([1, 2, 3]), /16 finite/);
});
