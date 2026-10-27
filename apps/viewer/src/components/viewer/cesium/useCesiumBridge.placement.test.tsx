/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hook's half of the globe placement: it builds the bridge with the
 * stored setting, publishes what was resolved for the Georeferencing panel,
 * and drops the flat terrain clip in Exact mode, where the model bends with
 * the Earth (7.85 m below the anchor's tangent plane at 10 km).
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import type { ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from '@/lib/geo/__fixtures__/proj-oracle.json' with { type: 'json' };
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import type { GlobePlacementMode } from '@/lib/geo/globe-placement';
import { clearTerrainElevationCache } from '@/lib/geo/terrain-elevation';
import { useViewerStore } from '@/store';
import { advance, cleanup, render } from '@/test/render';
import { rigidLine } from '@/test/geo-warp-fixture';
import { loadCesium } from './cesium-module';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import { useCesiumBridge } from './useCesiumBridge';

const UTM32: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };

afterEach(() => {
  cleanup();
  clearTerrainElevationCache();
  useViewerStore.setState({ cesiumGlobePlacement: 'auto', cesiumGlobePlacementStatus: null, cesiumTerrainClipY: null } as never);
});

async function mount(mode: GlobePlacementMode) {
  const Cesium = await loadCesium();
  // Terrain sampled at 60 m (ellipsoidal) under the model.
  const viewer = {
    scene: {
      sampleHeightSupported: true,
      sampleHeight() { return 60; },
      sampleHeightMostDetailed: async () => [{ height: 60 }],
      globe: { getHeight() { return 60; } },
    },
  } as unknown as InstanceType<typeof Cesium.Viewer>;
  const bridgeRef = { current: null as CesiumBridge | null };
  useViewerStore.setState({
    cesiumTerrainEnabled: true, cesiumDataSource: 'osm-map', cesiumHeightsAreEllipsoidal: true,
    cesiumTerrainClipY: null, cesiumGlobePlacement: mode, cesiumGlobePlacementStatus: null,
  } as never);
  const { mapConversion, coordinateInfo } = rigidLine(PROJ_ORACLE.warp[1]);
  function World() {
    useCesiumBridge({
      status: 'ready', viewerRef: { current: viewer }, viewerLifetimeRef: { current: new CesiumViewerLifetime(viewer) },
      bridgeRef, cameraBridgeRef: { current: null }, mapConversion, projectedCRS: UTM32, coordinateInfo, lengthUnitScale: 1,
    });
    return null;
  }
  render(<World />);
  for (let i = 0; i < 100 && !bridgeRef.current; i++) await advance(0);
  assert.ok(bridgeRef.current, 'the bridge was installed');
  return { bridge: bridgeRef.current, state: useViewerStore.getState() };
}

it('Exact: builds an Exact bridge, publishes it with the estimate, and turns the flat terrain clip off', async () => {
  const { bridge, state } = await mount('exact');
  assert.equal(bridge.placement.mode, 'exact');
  assert.equal(state.cesiumGlobePlacementStatus?.mode, 'exact');
  // Curvature at the 20 km line's 10 km ends alone: 1e8 / 12 742 000 = 7.85 m.
  assert.ok((state.cesiumGlobePlacementStatus?.anchorErrorMetres ?? 0) > 7.85);
  assert.equal(state.cesiumTerrainClipY, null);
});

it('Anchor: keeps the flat terrain clip and publishes the anchor placement', async () => {
  const { bridge, state } = await mount('anchor');
  assert.equal(bridge.placement.mode, 'anchor');
  assert.equal(state.cesiumGlobePlacementStatus?.mode, 'anchor');
  assert.equal(typeof state.cesiumTerrainClipY, 'number');
});
