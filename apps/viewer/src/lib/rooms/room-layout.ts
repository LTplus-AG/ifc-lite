/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Viewer history adapter for the canonical retained native Room layouts (#6232 D5). */
import { SpacePlateHandle } from '@ifc-lite/wasm';
import { flattenRoomRects, readFaces, applyLayoutOp, filterRoomFaces, type LayoutOp, type LayoutFace, type RoomPlate } from '../../../../../packages/create/src/in-store/room-layout-core.js';
import { RoomLayoutCache, roomWallsSignature } from '../../../../../packages/create/src/in-store/room-layout-cache.js';
import { DEFAULT_ROOM_CREATION } from './room-creation-options';
import type { ViewerState } from '@/store';
import type { Pt } from '@/lib/rooms/plate-geometry';
export { readFaces, applyLayoutOp, type LayoutFace, type LayoutOp } from '../../../../../packages/create/src/in-store/room-layout-core.js';

export const DEFAULT_WELD = .05;
export const DEFAULT_MIN_AREA = DEFAULT_ROOM_CREATION.minArea;
export const roomLayoutCache = new RoomLayoutCache();
const cache = roomLayoutCache;
export const layoutVersion = () => cache.version();
export function undoHead(s: ViewerState, modelId: string): string {
  const stack = s.undoStacks.get(modelId) ?? [];
  return `${stack.length}:${stack.at(-1)?.id ?? ''}`;
}
export const flattenRects = flattenRoomRects;
export const wallsSignature = roomWallsSignature;
export function buildPlate(rects: readonly (readonly Pt[])[], weld: number, minArea = DEFAULT_MIN_AREA): SpacePlateHandle {
  return SpacePlateHandle.fromWallRects(flattenRoomRects(rects), weld, minArea);
}
export function layoutFaces(s: ViewerState, modelId: string, storeyId: number, weld: number, rects: readonly (readonly Pt[])[], minArea = DEFAULT_MIN_AREA): LayoutFace[] {
  return filterRoomFaces(cache.read(modelId, storeyId, weld, undoHead(s, modelId), rects, SpacePlateHandle).faces, minArea);
}
export function editedLayout(s: ViewerState, modelId: string, storeyId: number, weld: number, rects: readonly (readonly Pt[])[], op: LayoutOp, tol: number): { plate: RoomPlate; walls: string; faces: LayoutFace[]; changed: boolean } {
  const entry = cache.read(modelId, storeyId, weld, undoHead(s, modelId), rects, SpacePlateHandle), plate = entry.plate.duplicate();
  try { return { plate, walls: entry.walls, changed: applyLayoutOp(plate, op, tol), faces: readFaces(plate) }; }
  catch (error) { plate.free(); throw error; }
}
export function fileLayout(s: ViewerState, modelId: string, storeyId: number, weld: number, walls: string, plate: RoomPlate, faces: LayoutFace[]): void {
  cache.file(modelId, storeyId, weld, undoHead(s, modelId), walls, plate, faces);
}
export const clearModelLayouts = (modelId: string) => cache.clearModel(modelId);
export const clearRoomLayouts = () => cache.clear();
