/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4879: through the viewer's SDK backend,
 * `bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })` writes the
 * camera in IFC world coordinates, and a world viewpoint read back through
 * `bim.bcf.extractViewpointState()` lands on the same render-frame camera
 * `bim.viewer.setCamera()` applies.
 *
 * `getCamera()` is the renderer's camera, which lives in the render frame: the
 * anchor model's wasm RTC offset (IFC Z-up) plus its CoordinateHandler origin
 * shift (Y-up) were subtracted from every vertex. The adapter reports that
 * frame by the same federation rule the BCF panel uses (earliest-loaded
 * model), so a later model's different frame must not leak in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBimContext, type BimBackend } from '@ifc-lite/sdk';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

type Vec = { x: number; y: number; z: number };
type Viewpoint = { position: Vec; target: Vec; up: Vec; fov: number; projectionMode: 'perspective' | 'orthographic' };

const RTC_IFC = { x: 41266.679, y: 308208.972, z: 125.95 };
const SHIFT_YUP = { x: 1800, y: -35, z: -2600 };
/** RTC as-is plus the Y-up shift in IFC axes: (x, -z, y). */
const WORLD_OFFSET_IFC = { x: RTC_IFC.x + 1800, y: RTC_IFC.y + 2600, z: RTC_IFC.z - 35 };

function coordinateInfo(originShift: Vec, wasmRtcOffset: Vec) {
  const box = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } };
  return { originShift, wasmRtcOffset, originalBounds: box, shiftedBounds: box, hasLargeCoordinates: true };
}

function makeStore() {
  let viewpoint: Viewpoint = {
    position: { x: 12, y: 8, z: -4 },
    target: { x: 2, y: 1, z: 3 },
    up: { x: 0, y: 1, z: 0 },
    fov: 0.9,
    projectionMode: 'perspective',
  };
  const models = new Map([
    // Inserted first but loaded LATER: its frame is not the scene's.
    ['later', { idOffset: 0, loadedAt: 200, geometryResult: { coordinateInfo: coordinateInfo({ x: 0, y: 0, z: 0 }, { x: 5, y: 6, z: 7 }) } }],
    ['anchor', { idOffset: 100_000, loadedAt: 100, geometryResult: { coordinateInfo: coordinateInfo(SHIFT_YUP, RTC_IFC) } }],
  ]);
  const state = {
    models,
    geometryResult: null,
    get projectionMode() {
      return viewpoint.projectionMode;
    },
    setProjectionMode: () => undefined,
    cameraCallbacks: {
      getViewpoint: () => viewpoint,
      applyViewpoint: (next: Viewpoint) => {
        viewpoint = next;
      },
    },
  };
  const store = {
    getState: () => state,
    subscribe: () => () => undefined,
  } as unknown as StoreApi;
  return { store, current: () => viewpoint };
}

describe('viewer SDK backend: BCF viewpoints in world coordinates (#4879)', () => {
  it('reports the anchor model\'s render frame -> world offset in IFC axes', () => {
    const { store } = makeStore();
    const offset = createViewerAdapter(store).getRenderFrameOffset?.();
    assert.ok(offset);
    assert.ok(Math.abs(offset[0] - WORLD_OFFSET_IFC.x) < 1e-6, `x ${offset[0]}`);
    assert.ok(Math.abs(offset[1] - WORLD_OFFSET_IFC.y) < 1e-6, `y ${offset[1]}`);
    assert.ok(Math.abs(offset[2] - WORLD_OFFSET_IFC.z) < 1e-6, `z ${offset[2]}`);
  });

  it('createViewpoint({ camera: getCamera() }) writes a world camera, and reading it back restores the render-frame camera', async () => {
    const { store, current } = makeStore();
    const bim = createBimContext({ backend: { viewer: createViewerAdapter(store) } as unknown as BimBackend });

    const vp = (await bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })) as {
      perspectiveCamera: { cameraViewPoint: Vec };
    };
    // Render-frame Y-up (12, 8, -4) is IFC (12, 4, 8); world adds the offset.
    const eye = vp.perspectiveCamera.cameraViewPoint;
    assert.ok(Math.abs(eye.x - (12 + WORLD_OFFSET_IFC.x)) < 1e-6, `eye.x ${eye.x}`);
    assert.ok(Math.abs(eye.y - (4 + WORLD_OFFSET_IFC.y)) < 1e-6, `eye.y ${eye.y}`);
    assert.ok(Math.abs(eye.z - (8 + WORLD_OFFSET_IFC.z)) < 1e-6, `eye.z ${eye.z}`);

    // Move away, then apply the world viewpoint back through the SDK.
    bim.viewer.setCamera({ position: [500, 500, 500] });
    const state = await bim.bcf.extractViewpointState(vp);
    assert.ok(state.camera);
    bim.viewer.setCamera(state.camera);
    const restored = current().position;
    assert.ok(Math.abs(restored.x - 12) < 1e-6 && Math.abs(restored.y - 8) < 1e-6 && Math.abs(restored.z + 4) < 1e-6,
      `restored ${JSON.stringify(restored)}`);
  });
});
