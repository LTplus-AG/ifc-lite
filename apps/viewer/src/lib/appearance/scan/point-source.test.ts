/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RetainedPointCloudSample } from '@/hooks/ingest/pointCloudScanCache';
import { alignedPointPreview, nativePointFromSample, pickScanPoint, pointLandmark, pointPreviewPosition, pointTransferPayload, samePointSource, samplePointFromNative, snapshotPointSource } from './point-source';
import { transferSource } from './prepare-transfer';
import type { ScanRegistrationReport } from './types';

function retained(native: number[][], origin: readonly [number, number, number] | null, colors?: number[], nativeNormals?: number[]): RetainedPointCloudSample {
  // The ingest subtracts the decode origin in f64, then swaps Z-up to Y-up before the reservoir sees a point.
  const positions = new Float32Array(native.length * 3);
  native.forEach(([x, y, z], i) => { const o = origin ?? [0, 0, 0]; positions.set([x - o[0], z - o[2], -(y - o[1])], i * 3); });
  const normals = nativeNormals ? new Float32Array(nativeNormals.length) : null;
  if (normals) for (let i = 0; i < native.length; i++) normals.set([nativeNormals![i * 3], nativeNormals![i * 3 + 2], -nativeNormals![i * 3 + 1]], i * 3);
  return { positions, colors: colors ? Uint8Array.from(colors) : null, normals, classifications: null, count: native.length, seen: native.length * 10, capacity: 2_000_000, origin };
}

test('retained sample positions map back to the file\'s native Z-up metres exactly, including a georeferenced decode origin (#4381)', () => {
  const origin: [number, number, number] = [2_600_000.5, 1_200_000.25, 400.125];
  const native = [[2_600_003.25, 1_200_001.5, 401.75], [2_600_000.5, 1_200_000.25, 400.125], [2_599_999.75, 1_200_002, 399]];
  const sample = retained(native, origin);
  native.forEach((point, i) => {
    const back = nativePointFromSample(sample, i);
    back.forEach((v, axis) => assert.ok(Math.abs(v - point[axis]) < 1e-6, `${i}/${axis}: ${v} vs ${point[axis]}`));
    const preview = samplePointFromNative(origin, back);
    assert.deepEqual([preview.x, preview.y, preview.z], [sample.positions[i * 3], sample.positions[i * 3 + 1], sample.positions[i * 3 + 2]]);
  });
  const raw = retained([[1, 2, 3]], null);
  assert.deepEqual(nativePointFromSample(raw, 0), [1, 2, 3]);
});

test('point picking prefers the nearest point inside the screen tolerance and ignores points behind the camera (#4381)', () => {
  // Two sheets along the ray at z=5 (near) and z=10 (far), plus a point behind the camera.
  const positions = new Float32Array([0.01, 0, 10, 0, 0.005, 5, 0, 0, -3, 0.5, 0, 5]);
  const ray = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
  const tolerance = (t: number) => 0.004 * t; // ~4 mm per metre of depth, like a perspective pixel radius
  assert.deepEqual(pickScanPoint(positions, 4, ray, tolerance)?.index, 1, 'the near sheet wins over the better-centred far point');
  assert.equal(pickScanPoint(positions, 4, ray, () => 0.001), null, 'nothing inside a 1 mm tolerance');
  assert.equal(pickScanPoint(positions, 4, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }, tolerance)?.index, 2, 'looking backwards finds only the point behind');
  assert.equal(pickScanPoint(positions, 4, ray, tolerance, { x: -0.5, y: 0, z: 0 })?.index, 3, 'a preview offset shifts every point');
});

test('point landmarks, payloads and previews are derived from the pinned snapshot, and reservoir changes invalidate it (#4381)', () => {
  const origin: [number, number, number] = [100, 200, 300];
  const sample = retained([[101, 202, 303], [104, 205, 306], [107, 208, 309], [110, 211, 312]], origin, [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const source = snapshotPointSource(7, sample);
  assert.equal(source.count, 4);
  const landmark = pointLandmark(source, 1);
  assert.equal(landmark.kind, 'point');
  assert.deepEqual(landmark.point.map(v => Math.round(v * 1e6) / 1e6), [104, 205, 306]);
  assert.equal(landmark.observation, 'point:1:seen:40');
  assert.throws(() => pointLandmark(source, 4), /no longer available/);
  const payload = pointTransferPayload(source);
  assert.equal(payload.positions.length, 12); assert.equal(payload.colors.length, 12);
  assert.deepEqual([...payload.positions.slice(3, 6)].map(v => Math.round(v * 1e6) / 1e6), [104, 205, 306]);
  assert.deepEqual([...payload.colors.slice(3, 6)], [0, 255, 0]);
  assert.equal(samePointSource(source, sample), true);
  sample.seen += 1;
  assert.equal(samePointSource(source, sample), false, 'a reservoir that saw more points is a different sample');
  assert.equal(samePointSource(source, null), false);
  assert.throws(() => snapshotPointSource(8, retained([[0, 0, 0]], null)), /too few/);
  // Aligned preview: a pure translation report moves every point by the same offset, about the target anchor.
  const report = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [10, 0, 0] } as unknown as ScanRegistrationReport;
  const aligned = alignedPointPreview(source, report);
  const expected = pointPreviewPosition(source, report, [101, 202, 303], true);
  assert.deepEqual([aligned[0], aligned[1], aligned[2]].map(v => Math.round(v * 1e4) / 1e4), [expected.x, expected.y, expected.z].map(v => Math.round(v * 1e4) / 1e4));
  assert.deepEqual([expected.x, expected.y, expected.z], [101, 303, -202], 'source landmarks land at their registered position relative to the target anchor');
});

test('a point source request records target-referenced orientation and validates its fit settings (#4381)', () => {
  const source = { kind: 'points' as const, points: snapshotPointSource(3, retained([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], null)) };
  const settings = { toleranceMetres: 0.01, reviewed: true, texelsPerMetre: 256, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
    neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 };
  const { source: request } = transferSource(source, settings);
  assert.deepEqual(request, { kind: 'points', pointCount: 4, orientation: 'target-referenced', neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003, viewpoints: [] });
  assert.throws(() => transferSource(source, { ...settings, surfaceBandMetres: 0.05 }), /surface band/);
  assert.throws(() => transferSource(source, { ...settings, neighborhoodRadiusMetres: 0.6 }), /support radius/);
  assert.throws(() => transferSource(source, { ...settings, minNeighbors: 2 }), /neighbours/);
  assert.throws(() => transferSource(source, { ...settings, maxNeighbors: 3 }), /neighbours/);
  // The planner's index bound (distance within 16 support radii) is read here, before any payload is shipped.
  assert.throws(() => transferSource(source, { ...settings, maxDistanceMetres: 0.5, neighborhoodRadiusMetres: 0.03, surfaceBandMetres: 0.003 }), /16 support radii/);
  assert.doesNotThrow(() => transferSource(source, { ...settings, maxDistanceMetres: 0.48, neighborhoodRadiusMetres: 0.03 }));
});

test('frozen point sessions detect independent XYZ and RGB mutation or row permutation (#4561)', () => {
  const native = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
  const colors = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const mutatedPosition = retained(native, null, colors);
  const positionSnapshot = snapshotPointSource(20, mutatedPosition);
  mutatedPosition.positions[0] += 1;
  assert.equal(samePointSource(positionSnapshot, mutatedPosition), false, 'XYZ-only mutation is stale');

  const permutedPosition = retained(native, null, colors);
  const permutationSnapshot = snapshotPointSource(21, permutedPosition);
  const firstPosition = permutedPosition.positions.slice(0, 3);
  permutedPosition.positions.copyWithin(0, 3, 6);
  permutedPosition.positions.set(firstPosition, 3);
  assert.equal(samePointSource(permutationSnapshot, permutedPosition), false, 'XYZ row permutation is stale');

  const mutatedColor = retained(native, null, colors);
  const colorSnapshot = snapshotPointSource(22, mutatedColor);
  mutatedColor.colors![0] += 1;
  assert.equal(samePointSource(colorSnapshot, mutatedColor), false, 'RGB-only mutation is stale');

  const permutedColor = retained(native, null, colors);
  const colorPermutationSnapshot = snapshotPointSource(23, permutedColor);
  const firstColor = permutedColor.colors!.slice(0, 3);
  permutedColor.colors!.copyWithin(0, 3, 6);
  permutedColor.colors!.set(firstColor, 3);
  assert.equal(samePointSource(colorPermutationSnapshot, permutedColor), false, 'RGB row permutation is stale');

  const colorless = retained(native, null);
  const neutralSnapshot = snapshotPointSource(24, colorless);
  neutralSnapshot.colors[0] = 0;
  assert.equal(samePointSource(neutralSnapshot, colorless), false, 'mutation of generated neutral RGB is stale too');
});

test('qualified PLY normals survive snapshot/frame conversion and select source-normals; malformed or stale rows refuse (#4561)', () => {
  const native = [[10, 20, 30], [11, 20, 30], [10, 21, 30], [11, 21, 30]];
  const nativeNormals = [2, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0];
  const sample = retained(native, [10, 20, 30], undefined, nativeNormals);
  const points = snapshotPointSource(11, sample);
  const settings = { toleranceMetres: 0.01, reviewed: true, texelsPerMetre: 256, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
    neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 };
  const request = transferSource({ kind: 'points', points }, settings).source;
  assert.equal(request.kind === 'points' && request.orientation, 'source-normals');
  const payload = pointTransferPayload(points);
  assert.deepEqual(Array.from(payload.normals), [1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0]);
  assert.deepEqual(Array.from(sample.normals!, value => value === 0 ? 0 : value), [2, 0, 0, 0, 0, -1, 0, 1, 0, -1, 0, 0], 'live Y-up source stays unchanged');
  sample.normals![0] = 0;
  assert.equal(samePointSource(points, sample), false, 'mutating only the live normal channel invalidates the session');
  sample.normals!.set([0, 0, -1, 2, 0, 0], 0);
  assert.equal(samePointSource(points, sample), false, 'permuting only normal rows also invalidates the session');
  const malformed = snapshotPointSource(12, retained(native, null, undefined, [0, 0, 0, ...nativeNormals.slice(3)]));
  assert.throws(() => transferSource({ kind: 'points', points: malformed }, settings), /normal 1.*zero/i);
  const nonFiniteSample = retained(native, null, undefined, [Number.NaN, 0, 1, ...nativeNormals.slice(3)]);
  const nonFinite = snapshotPointSource(13, nonFiniteSample);
  assert.equal(samePointSource(nonFinite, nonFiniteSample), true, 'unchanged NaN survives identity validation so transfer can report the malformed row');
  assert.throws(() => transferSource({ kind: 'points', points: nonFinite }, settings), /normal 1.*non-finite/i);
});
