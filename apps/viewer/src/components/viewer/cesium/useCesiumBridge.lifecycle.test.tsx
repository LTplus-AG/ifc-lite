/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { clearTerrainElevationCache } from '@/lib/geo/terrain-elevation';
import { useViewerStore } from '@/store';
import { advance, cleanup, render } from '@/test/render';
import { loadCesium } from './cesium-module';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import { useCesiumBridge } from './useCesiumBridge';

const MAP_CONVERSION = {
  eastings: 8.54,
  northings: 47.38,
  orthogonalHeight: 400,
  xAxisAbscissa: 1,
  xAxisOrdinate: 0,
  scale: 1,
} as unknown as MapConversion;

const PROJECTED_CRS = { id: 4326, name: 'EPSG:4326' } as ProjectedCRS;

afterEach(() => { cleanup(); clearTerrainElevationCache(); });

/** Wait for the real terrain pipeline to reach its only deferred GPU boundary. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await advance(0);
  }
  throw new Error(`timed out waiting for ${what}`);
}

it('does not publish retired bridge terrain work into a replacement Viewer (#4807)', async () => {
  const Cesium = await loadCesium();
  let resolveDetailed!: (positions: Array<{ height: number }>) => void;
  let detailedStarted = false;
  const pendingDetailed = new Promise<Array<{ height: number }>>((resolve) => { resolveDetailed = resolve; });

  // This is the actual terrain resolver's GPU boundary.  Everything around it
  // (the mounted hook, bridge construction, cancellation subscription, store
  // writes and ref publication) stays real.
  const oldViewer = {
    scene: {
      sampleHeightSupported: true,
      sampleHeight() { return undefined; },
      sampleHeightMostDetailed() { detailedStarted = true; return pendingDetailed; },
      globe: { getHeight() { return undefined; } },
    },
  } as unknown as InstanceType<typeof Cesium.Viewer>;
  const viewerRef = { current: oldViewer };
  const viewerLifetimeRef = { current: new CesiumViewerLifetime(oldViewer) };
  const bridgeRef = { current: null as CesiumBridge | null };
  const cameraBridgeRef = { current: null as CesiumBridge | null };

  useViewerStore.setState({
    cesiumTerrainEnabled: true,
    cesiumDataSource: 'osm-map',
    cesiumTerrainHeight: null,
    cesiumTerrainSource: null,
    cesiumTerrainSaveHeight: null,
    cesiumTerrainClipY: null,
  } as never);

  function World() {
    const { bridgeVersion } = useCesiumBridge({
      status: 'ready', viewerRef, viewerLifetimeRef, bridgeRef, cameraBridgeRef,
      mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, lengthUnitScale: 1,
    });
    return <output>{bridgeVersion}</output>;
  }

  const container = render(<World />);
  await waitFor(() => detailedStarted, 'the old Viewer terrain sample');

  const replacementBridge = { owner: 'replacement' } as unknown as CesiumBridge;
  const replacementCameraBridge = { owner: 'replacement-camera' } as unknown as CesiumBridge;
  bridgeRef.current = replacementBridge;
  cameraBridgeRef.current = replacementCameraBridge;
  useViewerStore.setState({
    cesiumTerrainHeight: 701,
    cesiumTerrainSource: 'replacement terrain',
    cesiumTerrainSaveHeight: 700,
    cesiumTerrainClipY: 699,
  } as never);

  // This is the production ownership handoff: the prior lifetime retires
  // synchronously, then its scene is replaced before its deferred sample can
  // settle. The old promise is deliberately completed afterwards.
  viewerLifetimeRef.current.retire();
  const replacementViewer = { scene: {} } as unknown as InstanceType<typeof Cesium.Viewer>;
  viewerRef.current = replacementViewer;
  viewerLifetimeRef.current = new CesiumViewerLifetime(replacementViewer);
  resolveDetailed([{ height: 123 }]);
  await advance(0);

  assert.strictEqual(bridgeRef.current, replacementBridge, 'old bridge work must not replace the new bridge ref');
  assert.strictEqual(cameraBridgeRef.current, replacementCameraBridge, 'old bridge work must not replace the new camera ref');
  assert.equal(container.querySelector('output')?.textContent, '0', 'retired work must not publish a bridge version');
  const state = useViewerStore.getState();
  assert.equal(state.cesiumTerrainHeight, 701, 'old terrain cannot overwrite replacement terrain state');
  assert.equal(state.cesiumTerrainSource, 'replacement terrain');
  assert.equal(state.cesiumTerrainSaveHeight, 700);
  assert.equal(state.cesiumTerrainClipY, 699);
});
