/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '@ifc-lite/renderer';
import { render, cleanup, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from './useBCF';
import { nativePointCloudOriginMatrix } from './ingest/pointCloudDecodeOrigin';
import { registerPointCloudScanCache, addPointsToScanCache, clearAllPointCloudScanCaches } from './ingest/pointCloudScanCache';
import { useScanSectionLayer } from './useScanSectionLayer';

afterEach(() => { cleanup(); clearAllPointCloudScanCaches(); setGlobalRendererRef({ current: null }); });
it('uses the final GPU world matrix without applying IFC RTC a second time (#4226)', async () => {
  const renderer = new Renderer(document.createElement('canvas'));
  // Fixture at the renderer boundary: native decode origin 1000 plus the
  // user's 7 m correction. The shader draws residual x=1 at world x=1008.
  const matrix = nativePointCloudOriginMatrix([1000, 0, 0]); matrix[12] += 7;
  renderer.getPointCloudTransform = () => new Float32Array(matrix);
  setGlobalRendererRef({ current: renderer });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('scan'), pointCloudHandleId: 7 }), pointCloudAlignmentEnabled: false });
  registerPointCloudScanCache(7, 1);
  addPointsToScanCache(7, { positions: new Float32Array([1, 0, 0]), pointCount: 1 });
  const bounds = { min: { x: 1000, y: 0, z: 0 }, max: { x: 1010, y: 1, z: 1 } };
  function Scan() {
    const result = useScanSectionLayer({ enabled: true, thickness: 0.01,
      sectionPlane: { axis: 'side', position: 80, flipped: false },
      coordinateInfo: { originalBounds: bounds, shiftedBounds: bounds,
        originShift: { x: 1000, y: 0, z: 0 }, hasLargeCoordinates: true },
      models: useViewerStore.getState().models, legacyPointClouds: undefined });
    return <output>{result.totalInBand}</output>;
  }
  const ui = render(<Scan />); await advance(150);
  assert.equal(ui.textContent, '1', 'the 2D cut at x=1008 includes the point drawn at x=1008 in 3D');
});
