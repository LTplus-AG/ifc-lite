/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoCameraAt } from '../demo-camera.mjs';

test('demo journey stays outside framing sphere and is translation/scale equivariant (#8567)', () => {
  const center = [12, 3, -8], radius = 4;
  for (let frame = 0; frame <= 900; frame++) {
    const t = frame / 30;
    const normalized = demoCameraAt(t, { center: [0, 0, 0], radius: 1 });
    const pose = demoCameraAt(t, { center, radius });
    const distance = Math.hypot(...pose.position.map((v, i) => v - center[i]));
    assert.ok(distance >= 1.65 * radius - 1e-10 && distance <= 2.8 * radius + 1e-10);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(pose.position[i] - center[i] - normalized.position[i] * radius) < 1e-10);
    assert.deepEqual(pose.target, center);
    assert.ok(pose.position[1] > center[1]);
  }
});

test('demo clamps endpoints, holds framing, and rejects invalid camera inputs (#8567)', () => {
  const framing = { center: [0, 0, 0], radius: 1 };
  assert.deepEqual(demoCameraAt(-1, framing), demoCameraAt(0, framing));
  assert.deepEqual(demoCameraAt(1, framing), demoCameraAt(3, framing));
  assert.deepEqual(demoCameraAt(29, framing), demoCameraAt(100, framing));
  for (const radius of [0, -1, Infinity, NaN]) assert.throws(() => demoCameraAt(1, { ...framing, radius }));
  assert.throws(() => demoCameraAt(NaN, framing));
});
