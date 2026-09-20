/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { convergeFederationRtcFrame } from './federationRtcRebase.js';

const ANCHOR = { x: 2_600_005, y: 5_000_005, z: 101 };

function coordinateInfo(anchored: boolean, originShift = { x: 0, y: 0, z: 0 }): CoordinateInfo {
  return {
    originShift,
    hasLargeCoordinates: anchored,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    ...(anchored ? { wasmRtcOffset: { ...ANCHOR }, wasmRtcFrame: { ...ANCHOR, needsShift: true } } : {}),
  };
}

function geometry(anchored: boolean, meshes: GeometryResult['meshes'], originShift?: { x: number; y: number; z: number }): GeometryResult {
  return { meshes, totalVertices: 0, totalTriangles: 0, coordinateInfo: coordinateInfo(anchored, originShift) };
}

function model(id: string, loadedAt: number, anchored: boolean, overlayOnly: boolean): FederatedModel {
  const result = fixtureModel(id);
  result.loadedAt = loadedAt;
  result.loadState = 'complete';
  // Native adapters establish an origin-shift frame without necessarily
  // carrying a wasm RTC offset. Meshless LandXML must adopt that full frame.
  result.geometryResult = geometry(anchored, overlayOnly ? [] : [{
    expressId: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [0, 0, 0],
  }], anchored ? { x: 17, y: -23, z: 31 } : undefined);
  if (overlayOnly) result.sourceSchema = 'LandXML-1.2';
  return result;
}

beforeEach(() => useViewerStore.getState().clearAllModels());

describe('LandXML overlay-only federation frames (#5042)', () => {
  for (const [firstOverlay, name] of [[true, 'LandXML first'], [false, 'anchored model first']] as const) {
    it(`adopts the shared frame when ${name}`, () => {
      const overlay = model('terrain', firstOverlay ? 1 : 2, false, true);
      const anchored = model('building', firstOverlay ? 2 : 1, true, false);
      useViewerStore.setState({ models: new Map([[overlay.id, overlay], [anchored.id, anchored]]) });

      convergeFederationRtcFrame();

      const terrain = useViewerStore.getState().models.get('terrain');
      assert.ok(terrain?.geometryResult);
      assert.deepEqual(terrain.geometryResult.coordinateInfo.wasmRtcOffset, ANCHOR);
      assert.deepEqual(terrain.geometryResult.coordinateInfo.originShift, { x: 17, y: -23, z: 31 });
      assert.deepEqual(totalYupOffset(terrain.geometryResult.coordinateInfo), { x: ANCHOR.x + 17, y: ANCHOR.z - 23, z: -ANCHOR.y + 31 });
    });
  }

  for (const [overlayLoadedFirst, name] of [[true, 'LandXML first'], [false, 'native model first']] as const) {
    it(`adopts a native origin-shift-only frame when ${name}`, () => {
      const overlay = model('terrain', overlayLoadedFirst ? 1 : 2, false, true);
      const native = model('native', overlayLoadedFirst ? 2 : 1, false, false);
      native.geometryResult!.coordinateInfo.originShift = { x: 2_600_005, y: 101, z: -5_000_005 };
      useViewerStore.setState({ models: new Map([[overlay.id, overlay], [native.id, native]]) });

      convergeFederationRtcFrame();

      const terrain = useViewerStore.getState().models.get('terrain');
      assert.deepEqual(terrain?.geometryResult?.coordinateInfo, native.geometryResult?.coordinateInfo);
    });
  }
});
