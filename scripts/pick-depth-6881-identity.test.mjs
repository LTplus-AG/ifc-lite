/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The #6881 hover cohort's cross-sample identity gate, exercised independently
// of the cohort that relies on it, against the recorded drifts that shaped it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameSampleIdentity, WORLD_TOLERANCE_METRES } from '../tests/e2e/pick-depth-6881-identity.mjs';

const evidence = name => JSON.parse(readFileSync(new URL(`../tests/evidence/point-depth-6881-20261025/${name}`, import.meta.url), 'utf8'));
const hit = (worldXYZ, expressId = 59753, geometryItemId = 59737) => ({ expressId, modelIndex: 0, worldXYZ, geometryItemId });
const sample = results => ({
  geometryBefore: { meshes: 42, digest: 'abc' }, viewport: { x: 314.25, y: 129, width: 1061.75, height: 743 },
  picks: results.map((result, index) => ({ result, matrix: [1, 0, 0, 1], cameraWorld: [0, 0, 10], texelInput: [index, 371.5, 1062, 743] })),
});
const base = { x: 8.610994132175435, y: 4.824427848520775, z: -2.4135964295655192 };
const shifted = (axis, metres) => ({ ...base, [axis]: base[axis] + metres });
const reference = sample([null, hit(base)]);

test('identical samples match', () => {
  assert.equal(sameSampleIdentity(reference, sample([null, hit(base)])), true);
});

test('world drift is bounded per axis at the tolerance', () => {
  assert.equal(WORLD_TOLERANCE_METRES, 1e-3);
  for (const axis of ['x', 'y', 'z']) {
    assert.equal(sameSampleIdentity(reference, sample([null, hit(shifted(axis, 0.999e-3))])), true, `${axis} within`);
    assert.equal(sameSampleIdentity(reference, sample([null, hit(shifted(axis, -1.001e-3))])), false, `${axis} beyond`);
  }
  assert.equal(sameSampleIdentity(reference, sample([null, hit(shifted('z', 10e-3))])), false);
});

test('anything but world position must match exactly', () => {
  assert.equal(sameSampleIdentity(reference, sample([null, hit(base, 59754)])), false, 'entity');
  assert.equal(sameSampleIdentity(reference, sample([null, hit(base, 59753, 59738)])), false, 'geometry item');
  assert.equal(sameSampleIdentity(reference, sample([null, null])), false, 'hit to miss');
  assert.equal(sameSampleIdentity(reference, sample([hit(base), hit(base)])), false, 'miss to hit');
  const camera = sample([null, hit(base)]); camera.picks[1].cameraWorld = [0, 0, 10 + 1e-9];
  assert.equal(sameSampleIdentity(reference, camera), false, 'camera');
  const texel = sample([null, hit(base)]); texel.picks[1].texelInput = [1, 371.5, 1062, 744];
  assert.equal(sameSampleIdentity(reference, texel), false, 'texel');
});

test('non-finite world positions never match', () => {
  for (const value of [NaN, Infinity, undefined]) {
    assert.equal(sameSampleIdentity(reference, sample([null, hit({ ...base, y: value })])), false, String(value));
  }
});

test('the recorded depth-ULP drift is accepted and the coplanar entity change refused', () => {
  const ulp = evidence('hover-attempt-6.json').identityDifferences;
  assert.ok(ulp.length > 0);
  for (const { reference: before, observed: after } of ulp) {
    const a = before.worldXYZ ?? before, b = after.worldXYZ ?? after;
    assert.equal(sameSampleIdentity(sample([hit(a)]), sample([hit(b)])), true);
  }
  const [flip] = evidence('hover-attempt-7.json').idDifferences;
  const { reference: r, observed: o } = flip;
  assert.equal(sameSampleIdentity(sample([hit(r.worldXYZ, r.expressId, r.geometryItemId)]),
    sample([hit(o.worldXYZ, o.expressId, o.geometryItemId)])), false);
});
