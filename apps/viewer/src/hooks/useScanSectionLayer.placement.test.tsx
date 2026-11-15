/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { PointCloudAsset } from '@ifc-lite/geometry';
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
  addPointsToScanCache(7, { positions: new Float32Array([1, 0, 0]), normalState: 'absent', pointCount: 1 });
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

it('ignores unrelated content bumps but recomputes cloud origin/chunk replacements (#10094, 3b)', async () => {
  const cloud: PointCloudAsset = { expressId: 90, origin: [0, 0, 0], chunk: {
    positions: new Float32Array([0, 0, 0]), pointCount: 1,
    bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  } };
  const model = fixtureModel('inline');
  useViewerStore.setState(fixtureModels(model));
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const coordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
  model.geometryResult = { meshes: [], pointClouds: [cloud], totalTriangles: 0, totalVertices: 0, coordinateInfo };
  let latest: ReturnType<typeof useScanSectionLayer>;
  function Scan() {
    latest = useScanSectionLayer({ enabled: true, thickness: 0.1,
      sectionPlane: { axis: 'side', position: 0, flipped: false }, coordinateInfo,
      models: useViewerStore((s) => s.models), legacyPointClouds: undefined });
    return <output>{latest.totalInBand}</output>;
  }
  const ui = render(<Scan />); await advance(150);
  assert.equal(ui.textContent, '1');
  const original = latest!;
  const bump = () => act(() => useViewerStore.setState((s) => ({ geometryContentVersion: s.geometryContentVersion + 1 })));
  bump(); await advance(150);
  assert.equal(latest!, original, 'no new selection was computed');
  cloud.origin = [1, 0, 0];
  bump(); await advance(150);
  assert.equal(ui.textContent, '0', 'origin replacement moves the point out of the cut');
  cloud.chunk = { ...cloud.chunk, positions: new Float32Array([-1, 0, 0]) };
  bump(); await advance(150);
  assert.equal(ui.textContent, '1', 'chunk replacement moves it back into the cut');
});

it('tracks streamed transforms and mesh references without debounce starvation (#10094, 3b review)', async () => {
  const renderer = new Renderer(document.createElement('canvas'));
  const matrix = new Float32Array(nativePointCloudOriginMatrix([0, 0, 0]));
  renderer.getPointCloudTransform = () => matrix;
  setGlobalRendererRef({ current: renderer });
  const scan = { ...fixtureModel('scan'), pointCloudHandleId: 7 };
  useViewerStore.setState({ ...fixtureModels(scan), pointCloudAlignmentEnabled: false });
  registerPointCloudScanCache(7, 10);
  const addPoint = () => addPointsToScanCache(7, {
    positions: new Float32Array([0, 0, 0]), normalState: 'absent', pointCount: 1,
  });
  addPoint();
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const coordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
  let latest: ReturnType<typeof useScanSectionLayer>;
  function Scan() {
    latest = useScanSectionLayer({ enabled: true, thickness: 0.1,
      sectionPlane: { axis: 'side', position: 0, flipped: false }, coordinateInfo,
      models: useViewerStore((s) => s.models), legacyPointClouds: undefined });
    return <output>{latest.totalInBand}</output>;
  }
  const bump = () => act(() => useViewerStore.setState((s) => ({ geometryContentVersion: s.geometryContentVersion + 1 })));
  const ui = render(<Scan />);
  await advance(50); addPoint(); bump();
  await advance(50); addPoint(); bump();
  await advance(50);
  assert.equal(ui.textContent, '3', 'stream updates do not postpone the pending debounce');
  const original = latest!;
  bump(); await advance(150);
  assert.equal(latest!, original, 'unchanged matrix values do not recompute');
  matrix[12] = 1;
  bump(); await advance(150);
  assert.equal(ui.textContent, '0', 'in-place GPU transform change moves points out of the cut');
  matrix[12] = 0;
  bump(); await advance(150);
  assert.equal(ui.textContent, '3');
  const beforeReference = latest!;
  act(() => useViewerStore.setState({ models: new Map([['scan', scan], ['mesh', fixtureModel('mesh')]]) }));
  await advance(150);
  assert.notEqual(latest!, beforeReference, 'adding a mesh-only reference triggers recompute');
  const withReference = latest!;
  act(() => useViewerStore.setState({ models: new Map([['scan', scan]]) }));
  await advance(150);
  assert.notEqual(latest!, withReference, 'removing a mesh-only reference triggers recompute');
});
