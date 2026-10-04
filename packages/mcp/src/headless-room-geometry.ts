/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withHeadlessGeometry } from './headless-native-geometry.js';
import { ToolErrorCode, ToolExecutionError } from './errors.js';
import {
  wallRectsFromMeshes, roomFrameToModelWorld, roomFramePlanOffsets, storeyPlanFrame, toStoreyLocal,
  effectiveStoreyIds, effectiveStoreyElevation, floorToFloorHeight, spaceMeshTriangles,
  existingSpaceFootprintEntriesByStorey, occupancyTest, type RoomPlateFactory,
} from '@ifc-lite/create';
import type { RoomGeometryProvider } from '@ifc-lite/sdk';

/** Keep native factory closures independent of the large parsed-model scope. */
function nativeRoomFactory(runtime: typeof import('@ifc-lite/wasm')): RoomPlateFactory {
  return { fromWallRects: (rects, weld, minArea) => runtime.SpacePlateHandle.fromWallRects(rects, weld, minArea) };
}

/** Mesh the current export, including authored edits, through the canonical native geometry path. */
const prepareHeadlessRoomGeometry: RoomGeometryProvider = async (model, storeyId) => {
  const schema = model.store.schemaVersion ?? 'IFC4';
  if (schema !== 'IFC4' && schema !== 'IFC2X3' && schema !== 'IFC4X3') throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `Room does not support schema ${schema}` });
  return withHeadlessGeometry(model, source => {
    const plan = storeyPlanFrame(source, storeyId);
    if (!plan) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Room storey placement is not a supported upright plane' });
    const storeys = effectiveStoreyIds(source, null).map(id => ({ id, elev: effectiveStoreyElevation(source, null, id) })).sort((a, b) => a.elev - b.elev || a.id - b.id);
    const floor = storeys.find(storey => storey.id === storeyId);
    if (!floor) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Room requires a live IfcBuildingStorey' });
    return { source, plan, storeys, floor };
  }, async ({ source, plan, storeys, floor }, meshes, coord) => {
    const { dx, dy } = roomFrameToModelWorld(coord);
    const local = (point: [number, number]) => toStoreyLocal(plan, [point[0] + dx, point[1] + dy]);
    const walls = wallRectsFromMeshes(meshes, coord, floor.elev, floorToFloorHeight(storeys, storeyId)).map(wall => ({
      ...wall, corners: wall.corners.map(local), centreline: [local(wall.centreline[0]), local(wall.centreline[1])] as [[number, number], [number, number]],
    }));
    const spaces = existingSpaceFootprintEntriesByStorey(source).get(storeyId) ?? [];
    const { cx, cy } = roomFramePlanOffsets(coord), shiftY = coord?.originShift?.y ?? 0;
    const triangles = spaceMeshTriangles(meshes, { lo: floor.elev - shiftY + .2, hi: floor.elev + floorToFloorHeight(storeys, storeyId) - shiftY - .2 }, (x, _y, z) => local([x + cx, cy - z]), () => true);
    const runtime = await import('@ifc-lite/wasm');
    return { walls, spaces, occupied: occupancyTest(spaces.map(space => space.footprint), triangles), factory: nativeRoomFactory(runtime) };
  });
};

/** Preserve intentional refusals; infrastructure failures are not caller input. */
export const provideHeadlessRoomGeometry: RoomGeometryProvider = async (model, storeyId) => {
  try { return await prepareHeadlessRoomGeometry(model, storeyId); }
  catch (error) {
    if (error instanceof ToolExecutionError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR,
      message: `Native Room preparation failed: ${error instanceof Error ? error.message : String(error)}` });
  }
};

/** One prepared storey per loaded model; cached values hold no native handles. */
export function createCachedHeadlessRoomGeometryProvider() {
  type Model = Parameters<RoomGeometryProvider>[0];
  type Prepared = Awaited<ReturnType<RoomGeometryProvider>>;
  const entries = new Map<string, { store: WeakRef<Model['store']>; view: WeakRef<Model['mutationView']>; head: string; storeyId: number; geometry: Prepared }>();
  let generation = 0;
  const provide: RoomGeometryProvider = async (model, storeyId) => {
    const head = model.mutationView.getMutations().map(mutation => mutation.id).join('|');
    const entry = entries.get(model.modelId);
    if (entry?.store.deref() === model.store && entry.view.deref() === model.mutationView && entry.head === head && entry.storeyId === storeyId) return entry.geometry;
    const epoch = generation, geometry = await provideHeadlessRoomGeometry(model, storeyId);
    if (generation === epoch) entries.set(model.modelId, { store: new WeakRef(model.store), view: new WeakRef(model.mutationView), head, storeyId, geometry });
    return geometry;
  };
  return { provide, clear() { generation++; entries.clear(); } };
}
