/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A federated two-model scene for scene-action tests (#6907): real store
 * entries with GlobalIds, id offsets, parse ranges and a georeferenced render
 * frame (an RTC offset of 1000 m east / 2000 m north), plus a camera stub that
 * records what the viewer would have been told to do.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { CameraCallbacks, CameraViewpoint, FederatedModel } from '@/store/types';
import { fixtureModel, fixtureModels, type FixtureEntity } from './store-fixture';

export const W1 = '0Wall00000000000000101';
export const W2 = '0Wall00000000000000102';
export const SHARED = '0Shared000000000000001';
/** Offset of the second model's renderer ids. */
export const B_OFFSET = 10_000;

/** The render-frame geometry of one fixture model: IFC world = render frame + the WASM RTC offset (1000, 2000, 0). */
function sceneGeometry(): GeometryResult {
  return {
    meshes: [],
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: -10 }, max: { x: 20, y: 5, z: 0 } },
      // Render frame, Y-up: x 0..20 m east, y 0..5 m up, z -10..0 (north is −z).
      shiftedBounds: { min: { x: 0, y: 0, z: -10 }, max: { x: 20, y: 5, z: 0 } },
      hasLargeCoordinates: false,
      wasmRtcOffset: { x: 1000, y: 2000, z: 0 },
    },
  } as unknown as GeometryResult;
}

function sceneModel(id: string, idOffset: number, entities: FixtureEntity[]): FederatedModel {
  return { ...fixtureModel(id, { idOffset, entities }), maxExpressId: 1000, loadedAt: idOffset + 1, loadState: 'complete', geometryResult: sceneGeometry() };
}

export function sceneModels() {
  return fixtureModels(
    sceneModel('a', 0, [
      { expressId: 101, type: 'IfcWall', globalId: W1, name: 'Wall A' },
      { expressId: 102, type: 'IfcWall', globalId: W2, name: 'Wall B' },
      { expressId: 103, type: 'IfcSlab', globalId: SHARED, name: 'Slab' },
    ]),
    sceneModel('b', B_OFFSET, [{ expressId: 103, type: 'IfcSlab', globalId: SHARED, name: 'Slab copy' }]),
  );
}

export const VIEWPOINT: CameraViewpoint = {
  position: { x: 30, y: 20, z: 30 }, target: { x: 10, y: 2, z: -5 }, up: { x: 0, y: 1, z: 0 }, fov: 45, projectionMode: 'perspective',
};

/** Camera callbacks that move a recorded viewpoint instead of a GPU camera. */
export function cameraStub() {
  let current: CameraViewpoint = { ...VIEWPOINT };
  const framed: number[][] = [];
  const applied: CameraViewpoint[] = [];
  const callbacks: CameraCallbacks = {
    getViewpoint: () => ({ ...current }),
    applyViewpoint: (viewpoint) => { applied.push(viewpoint); current = { ...viewpoint }; },
    frameEntities: (ids) => { framed.push(ids); current = { ...current, target: { x: 1, y: 1, z: -1 } }; },
  };
  return { callbacks, framed, applied, current: () => current };
}
