/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A storey's candidate rooms for the Room tool (charter #6232 M4, decision
 * D4): derived on demand from the storey's walls, never persisted.
 *
 *   1. wall footprint rectangles from the rendered meshes
 *      (`wallRectsFromMeshes`, the room frame), so file walls and authored
 *      walls — re-meshed through wasm since #6391 — count alike;
 *   2. each rectangle's corners into the session workplane's storey-local
 *      frame, the frame `addSpace` writes and the plan draws in: room frame →
 *      render (pre-placement) → the model's workspace placement →
 *      `Workplane.renderToLocal`, which undoes placement, federation
 *      alignment and the storey chain in one place;
 *   3. the storey's room layout (`room-layout.ts`): the wasm DCEL over those
 *      rectangles, as the tool's Edit mode last left it at this undo step.
 *
 * A face whose interior point already lies in an IfcSpace on the storey is
 * `taken` (`room-occupancy.ts`): Auto skips it and a click on it is refused,
 * so running the tool twice never stacks two rooms. A taken face that IS a
 * room (its outline, `linkFaces`) carries that room, which Edit mode reshapes.
 */

import { CoordinateHandler, type MeshData } from '@ifc-lite/geometry';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { liveStoreyMembers } from '@/lib/visibility/storey-context';
import { existingSpaceFootprintEntriesByStorey, liveEntityConforms, type SpaceFootprint } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { roomFramePlanOffsets, wallRectsFromMeshes } from '@/lib/wall-rects-from-meshes';
import { spaceWasmLoaded } from '@/lib/rooms/space-wasm';
import { type Pt } from '@/lib/rooms/plate-geometry';
import { occupancyTest, spaceMeshTriangles } from './room-occupancy';
import { buildPlate, clearRoomLayouts, DEFAULT_MIN_AREA, DEFAULT_WELD, layoutFaces, layoutVersion, readFaces, undoHead } from './room-layout';
import { floorToFloorHeight } from './floor-height';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import type { CommandContext, Workplane } from '@/lib/commands/modeling/types';

export type { Pt };
import { roomCandidatesFromFaces, type RoomCandidate } from '../../../../../packages/create/src/in-store/room-candidates.js';
export { roomAt, interiorPoint, roomOutline, roomCandidatesFromFaces, type RoomCandidate, type RoomBoundary } from '../../../../../packages/create/src/in-store/room-candidates.js';

/** A storey's wall, storey-local: its footprint rectangle, axis and thickness. */
export interface LocalWall {
  corners: Pt[];
  centreline: [Pt, Pt];
  thickness: number;
}

export type StoreyRooms =
  | { status: 'ready'; rooms: RoomCandidate[]; walls: number }
  | { status: 'loading' }
  | { status: 'noWalls' };

const WALL_TYPES = new Set(['IfcWall', 'IfcWallStandardCase']);
/** Inset of a storey's height band, as `wallRectsFromMeshes` insets its own. */
const BAND_MARGIN = 0.2;

/** Wall rectangles (storey-local, 4 corners each) → candidate rooms of a fresh layout, `taken` where `occupied`. */
export function roomCandidatesFromRects(rects: readonly Pt[][], occupied: (p: Pt) => boolean = () => false): RoomCandidate[] {
  if (rects.length === 0) return [];
  const plate = buildPlate(rects, DEFAULT_WELD);
  try {
    return roomCandidatesFromFaces(readFaces(plate), occupied);
  } finally {
    plate.free();
  }
}

/**
 * Room-frame plan points → the workplane's storey-local plan. The room frame
 * is render + origin shift (`roomFramePlanOffsets`), before the model's
 * workspace placement; the workplane expects displayed render points.
 */
function roomFrameToLocal(s: ViewerState, modelId: string, plane: Workplane, meshesCoord: Parameters<typeof roomFramePlanOffsets>[0]) {
  const { cx, cy } = roomFramePlanOffsets(meshesCoord);
  const placement = { translation: displayedTranslation(s.modelPlacement, modelId), rotation: placementFor(s.modelPlacement, modelId).rotation };
  return ([x, y]: Pt): Pt => {
    const render = { x: x - cx, y: 0, z: cy - y };
    const shown = toRenderTranslation(modelPointToWorkspacePoint(fromRenderTranslation(render), placement));
    const local = plane.renderToLocal(shown);
    return [local[0], local[1]];
  };
}

/** Whether `mesh` belongs to an element that is still in the model. */
function liveMesh(s: ViewerState, modelId: string): (mesh: MeshData) => boolean {
  const view = s.mutationViews.get(modelId);
  return (mesh) => {
    const local = s.resolveGlobalIdFromModels(mesh.expressId);
    const store = s.models.get(modelId)?.ifcDataStore;
    return !!local && local.modelId === modelId && !!store && !view?.isDeleted(local.expressId)
      && (!mesh.ifcType || liveEntityConforms(store, local.expressId, mesh.ifcType, view));
  };
}

/** What deriving a storey's rooms needs: its height band and the map into its storey-local plan. */
function storeyPlan(s: ViewerState, modelId: string, storeyId: number, plane: Workplane) {
  const model = s.models.get(modelId);
  const coord = model?.geometryResult?.coordinateInfo;
  const storeys = modelStoreys(s, modelId);
  const storey = storeys.find((st) => st.expressId === storeyId);
  if (!storey) return null;
  const floorToFloor = floorToFloorHeight(storeys.map((st) => ({ id: st.expressId, elev: st.elevation })), storeyId);
  const shiftY = coord?.originShift?.y ?? 0;
  return {
    meshes: model?.geometryResult?.meshes ?? [],
    coord,
    elevation: storey.elevation,
    floorToFloor,
    /** Render-Y band of the storey, inset like the wall band. */
    band: { lo: storey.elevation - shiftY + BAND_MARGIN, hi: storey.elevation + floorToFloor - shiftY - BAND_MARGIN },
    toLocal: roomFrameToLocal(s, modelId, plane, coord),
  };
}

/** Refresh contained products plus spanning geometry the same height-band readers use. */
export function storeyRoomGeometryIds(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): number[] {
  const store = s.models.get(modelId)?.ifcDataStore, at = storeyPlan(s, modelId, storeyId, plane);
  if (!store || !at) return [];
  const view = s.mutationViews.get(modelId), ids = new Set<number>();
  const contained = new Set(liveStoreyMembers(store, view, [storeyId]).get(storeyId) ?? []);
  const candidates = new Set<number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSPACE'])) {
    candidates.add(expressId);
    if (contained.has(expressId)) ids.add(expressId);
  }
  const coordinates = new CoordinateHandler(), live = liveMesh(s, modelId);
  for (const mesh of at.meshes) {
    if ((!mesh.ifcType || !WALL_TYPES.has(mesh.ifcType)) && mesh.ifcType !== 'IfcSpace') continue;
    if (!live(mesh)) continue;
    const bounds = coordinates.calculateBounds([mesh], Infinity);
    if (!(bounds.max.y > at.band.lo && bounds.min.y < at.band.hi)) continue;
    const local = s.resolveGlobalIdFromModels(mesh.expressId);
    if (local?.modelId === modelId) ids.add(local.expressId);
  }
  // Native instanced-only products may have no flat CPU mesh yet. These
  // authoritative absolute Y-up boxes use the same band before JS shifting.
  const shiftY = at.coord?.originShift?.y ?? 0;
  for (const [globalId, bounds] of s.models.get(modelId)?.geometryResult?.instancedGeometryAabbs ?? []) {
    if (!(bounds.max[1] > at.band.lo + shiftY && bounds.min[1] < at.band.hi + shiftY)) continue;
    const local = s.resolveGlobalIdFromModels(globalId);
    if (local?.modelId === modelId && candidates.has(local.expressId)) ids.add(local.expressId);
  }
  return [...ids];
}

let wallsCache: { modelId: string; store: unknown; view: unknown; revision: number | undefined; meshes: unknown; count: number; version: number; plane: Workplane; storeyId: number; walls: LocalWall[] } | null = null;

/** The storey's walls in its storey-local frame (the last storey's are kept: a layer asks every frame). */
export function storeyWalls(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): LocalWall[] {
  const meshes = s.models.get(modelId)?.geometryResult?.meshes;
  const store = s.models.get(modelId)?.ifcDataStore, view = s.mutationViews.get(modelId), revision = view?.getMutationRevision();
  const c = wallsCache;
  if (c && c.modelId === modelId && c.store === store && c.view === view && c.revision === revision && c.meshes === meshes && c.count === (meshes?.length ?? 0) && c.version === s.mutationVersion && c.plane === plane && c.storeyId === storeyId) {
    return c.walls;
  }
  const walls = deriveStoreyWalls(s, modelId, storeyId, plane);
  wallsCache = { modelId, store, view, revision, meshes, count: meshes?.length ?? 0, version: s.mutationVersion, plane, storeyId, walls };
  return walls;
}

function deriveStoreyWalls(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): LocalWall[] {
  const at = storeyPlan(s, modelId, storeyId, plane);
  if (!at) return [];
  const live = liveMesh(s, modelId);
  const walls = at.meshes.filter((m) => m.ifcType !== undefined && WALL_TYPES.has(m.ifcType) && live(m));
  return wallRectsFromMeshes(walls, at.coord, at.elevation, at.floorToFloor).map((rect) => ({
    corners: rect.corners.map(at.toLocal),
    centreline: [at.toLocal(rect.centreline[0]), at.toLocal(rect.centreline[1])],
    thickness: rect.thickness,
  }));
}

/** The storey's wall rectangles in its storey-local frame. */
export function storeyWallRects(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): Pt[][] {
  return storeyWalls(s, modelId, storeyId, plane).map((w) => w.corners);
}

/** Whether a storey-local plan point already lies in a room of the storey. */
export function storeyOccupancy(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): (p: Pt) => boolean {
  const at = storeyPlan(s, modelId, storeyId, plane);
  if (!at) return () => false;
  const { cx, cy } = roomFramePlanOffsets(at.coord);
  const triangles = spaceMeshTriangles(at.meshes, at.band, (x, _y, z) => at.toLocal([x + cx, cy - z]), liveMesh(s, modelId));
  return occupancyTest(storeySpaceFootprints(s, modelId, storeyId), triangles);
}

let footprintCache: { store: unknown; view: unknown; revision: number | undefined; version: number; byStorey: Map<number, SpaceFootprint[]> } | null = null;

/** Existing IfcSpaces on the storey with their footprint rings, storey-local. */
export function storeySpaces(s: ViewerState, modelId: string, storeyId: number): SpaceFootprint[] {
  const store = s.models.get(modelId)?.ifcDataStore;
  if (!store) return [];
  const view = s.mutationViews.get(modelId), revision = view?.getMutationRevision();
  if (footprintCache?.store !== store || footprintCache.view !== view || footprintCache.revision !== revision || footprintCache.version !== s.mutationVersion) {
    footprintCache = { store, view, revision, version: s.mutationVersion, byStorey: existingSpaceFootprintEntriesByStorey(store, view) };
  }
  return footprintCache.byStorey.get(storeyId) ?? [];
}

/** Existing IfcSpace footprints on the storey, storey-local. */
export function storeySpaceFootprints(s: ViewerState, modelId: string, storeyId: number): Pt[][] {
  return storeySpaces(s, modelId, storeyId).map((e) => e.footprint as Pt[]);
}

interface CacheEntry {
  store: unknown;
  view: unknown;
  revision: number | undefined;
  meshes: readonly MeshData[] | undefined;
  meshCount: number;
  mutationVersion: number;
  head: string;
  layouts: number;
  plane: Workplane;
  storeyId: number;
  modelId: string;
  weld: number;
  minArea: number;
  result: StoreyRooms;
}

/** One entry: the tool works one storey at a time, and a hover asks every frame. */
let cached: CacheEntry | null = null;

/**
 * The storey's candidate rooms, derived once per wall geometry / edit /
 * workplane / weld and then served from cache. `loading` until the space
 * wasm is initialised (`ensureSpaceWasm`), which the tool starts on launch.
 */
export function storeyRooms(s: ViewerState, modelId: string, storeyId: number, plane: Workplane, weld = DEFAULT_WELD, minArea = DEFAULT_MIN_AREA): StoreyRooms {
  if (!spaceWasmLoaded()) return { status: 'loading' };
  const meshes = s.models.get(modelId)?.geometryResult?.meshes;
  const head = undoHead(s, modelId);
  const store = s.models.get(modelId)?.ifcDataStore, view = s.mutationViews.get(modelId), revision = view?.getMutationRevision();
  const c = cached;
  if (c && c.store === store && c.view === view && c.revision === revision && c.meshes === meshes && c.meshCount === (meshes?.length ?? 0) && c.mutationVersion === s.mutationVersion
    && c.head === head && c.layouts === layoutVersion() && c.plane === plane && c.storeyId === storeyId && c.modelId === modelId && c.weld === weld && c.minArea === minArea) {
    return c.result;
  }
  const rects = storeyWallRects(s, modelId, storeyId, plane);
  const result: StoreyRooms = rects.length === 0
    ? { status: 'noWalls' }
    : {
      status: 'ready',
      rooms: roomCandidatesFromFaces(layoutFaces(s, modelId, storeyId, weld, rects, minArea), storeyOccupancy(s, modelId, storeyId, plane), storeySpaces(s, modelId, storeyId)),
      walls: rects.length,
    };
  cached = { store, view, revision, meshes, meshCount: meshes?.length ?? 0, mutationVersion: s.mutationVersion, head, layouts: layoutVersion(), plane, storeyId, modelId, weld, minArea, result };
  return result;
}

/** A command session's storey rooms, or null while it has no plane to derive them on. */
export function sessionRooms(ctx: Pick<CommandContext, 'get' | 'modelId' | 'storeyId' | 'workplane'>, weld = DEFAULT_WELD, minArea = DEFAULT_MIN_AREA): StoreyRooms | null {
  if (!ctx.workplane || ctx.storeyId === null) return null;
  return storeyRooms(ctx.get(), ctx.modelId, ctx.storeyId, ctx.workplane, weld, minArea);
}

/** Forget the cached storey and every filed room layout (tests; a reloaded model). */
export function clearStoreyRoomsCache(): void {
  clearRoomLayouts();
  cached = null;
  footprintCache = null;
  wallsCache = null;
}
