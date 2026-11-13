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
import type { FederatedModel } from '@/store/types';
import { useViewerStore } from '@/store';
import { testPlacement } from '@/lib/model-placement/test-fixtures';
import { collectScanSources } from './useScanSectionLayer.js';
import { selectScanBand } from './scanSectionMath.js';
import { fixtureModel } from '@/test/store-fixture.js';

it('an inline cloud with an origin keeps two points 0.1 m apart at 2,600,000 m in the section, legacy and federated (#10029)', () => {
  const asset: PointCloudAsset = { expressId: 1, origin: [2_600_000.02, 0, 0], chunk: { pointCount: 2,
    positions: new Float32Array([0, 0, 0, 0.1, 0, 0]), bbox: { min: [0, 0, 0], max: [0.1, 0, 0] } } };
  const federated = { ...fixtureModel('m'), geometryResult: { meshes: [], pointClouds: [asset] } } as unknown as FederatedModel;
  // The federated model is moved 0.5 m east; that move composes on top of the origin.
  const before = useViewerStore.getState().modelPlacement;
  useViewerStore.setState({ modelPlacement: { ...before,
    placements: new Map([['m', testPlacement([0.5, 0, 0])]]) } });
  try {
    const paths = {
      legacy: { sources: collectScanSources(new Map(), [asset]), x0: 2_600_000.02 },
      federated: { sources: collectScanSources(new Map([['m', federated]]), undefined), x0: 2_600_000.52 },
    };
    for (const [path, { sources, x0 }] of Object.entries(paths)) {
      assert.equal(sources.length, 1, `${path}: one source collected`);
      const { points } = selectScanBand({ sample: sources[0], model: sources[0].model, modelOutputsRenderFrame: sources[0].modelOutputsRenderFrame,
        coordinateInfo: undefined, plane: { axis: 'y', position: 0, flipped: false }, thickness: 1 });
      assert.equal(points.length, 2, path);
      assert.ok(Math.abs(points[0].point.x - x0) < 1e-4, `${path}: first point at ${points[0].point.x}`);
      assert.ok(Math.abs(points[1].point.x - points[0].point.x - 0.1) < 1e-4, `${path}: points ${points[1].point.x - points[0].point.x} m apart`);
    }
  } finally {
    useViewerStore.setState({ modelPlacement: before });
  }
});
