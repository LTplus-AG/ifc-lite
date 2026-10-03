/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withHeadlessGeometry } from './headless-native-geometry.js';
import {
  wallRectsFromMeshes, roomFrameToModelWorld, roomFramePlanOffsets, storeyPlanFrame, toStoreyLocal,
  effectiveStoreyIds, effectiveStoreyElevation, floorToFloorHeight, spaceMeshTriangles,
  existingSpaceFootprintEntriesByStorey, occupancyTest,
} from '@ifc-lite/create';
import type { RoomGeometryProvider } from '@ifc-lite/sdk';

/** Mesh the current export, including authored edits, through the canonical native geometry path. */
export const provideHeadlessRoomGeometry: RoomGeometryProvider = async (model, storeyId) => {
  const schema = model.store.schemaVersion ?? 'IFC4';
  if (schema !== 'IFC4' && schema !== 'IFC2X3' && schema !== 'IFC4X3') throw new Error(`Room does not support schema ${schema}`);
  return withHeadlessGeometry(model, async (source, meshes, coord) => {
  const plan = storeyPlanFrame(source, storeyId);
  if (!plan) throw new Error('Room storey placement is not a supported upright plane');
  const storeys = effectiveStoreyIds(source, null).map(id => ({ id, elev: effectiveStoreyElevation(source, null, id) })).sort((a, b) => a.elev - b.elev || a.id - b.id);
  const floor = storeys.find(storey => storey.id === storeyId);
  if (!floor) throw new Error('Room requires a live IfcBuildingStorey');
    const { dx, dy } = roomFrameToModelWorld(coord);
    const local = (point: [number, number]) => toStoreyLocal(plan, [point[0] + dx, point[1] + dy]);
    const walls = wallRectsFromMeshes(meshes, coord, floor.elev, floorToFloorHeight(storeys, storeyId)).map(wall => ({
      ...wall, corners: wall.corners.map(local), centreline: [local(wall.centreline[0]), local(wall.centreline[1])] as [[number, number], [number, number]],
    }));
    const spaces = existingSpaceFootprintEntriesByStorey(source).get(storeyId) ?? [];
    const { cx, cy } = roomFramePlanOffsets(coord), shiftY = coord?.originShift?.y ?? 0;
    const triangles = spaceMeshTriangles(meshes, { lo: floor.elev - shiftY + .2, hi: floor.elev + floorToFloorHeight(storeys, storeyId) - shiftY - .2 }, (x, _y, z) => local([x + cx, cy - z]), () => true);
    const runtime = await import('@ifc-lite/wasm');
    return { walls, spaces, occupied: occupancyTest(spaces.map(space => space.footprint), triangles), factory: {
      fromWallRects: (rects, weld, minArea) => runtime.SpacePlateHandle.fromWallRects(rects, weld, minArea),
    } };
  });
};
