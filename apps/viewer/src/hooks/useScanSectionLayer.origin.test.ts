/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D scan section places an inline cloud through its f64 origin (#10029):
 * two points 0.1 m apart at x = 2,600,000 m stay 0.1 m apart in the drawing.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { collectScanSources } from './useScanSectionLayer.js';
import { selectScanBand } from './scanSectionMath.js';

it('an inline cloud with an origin keeps two points 0.1 m apart at 2,600,000 m in the section (#10029)', () => {
  const asset: PointCloudAsset = { expressId: 1, origin: [2_600_000.02, 0, 0], chunk: { pointCount: 2,
    positions: new Float32Array([0, 0, 0, 0.1, 0, 0]), bbox: { min: [0, 0, 0], max: [0.1, 0, 0] } } };
  const [source] = collectScanSources(new Map(), [asset]);
  const { points } = selectScanBand({ sample: source, model: source.model, modelOutputsRenderFrame: source.modelOutputsRenderFrame,
    coordinateInfo: undefined, plane: { axis: 'y', position: 0, flipped: false }, thickness: 1 });
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[0].point.x - 2_600_000.02) < 1e-4, `first point at ${points[0].point.x}`);
  assert.ok(Math.abs(points[1].point.x - points[0].point.x - 0.1) < 1e-4, `points ${points[1].point.x - points[0].point.x} m apart`);
});
