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

import type { MeshData } from '@ifc-lite/geometry';
import { existingSpaceFootprintEntriesByStorey, type SpaceFootprint } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { roomFramePlanOffsets, wallRectsFromMeshes } from '@/lib/wall-rects-from-meshes';
import { spaceWasmLoaded } from '@/lib/space-plate-session';
import { pointInPoly, polyArea, type Pt } from '@/lib/space-sketch-geometry';
import { linkFaces, occupancyTest, spaceMeshTriangles, type RoomLink } from './room-occupancy';
import { buildPlate, DEFAULT_WELD, layoutFaces, layoutVersion, readFaces, undoHead, type LayoutFace } from './room-layout';
import { floorToFloorHeight } from '@/components/viewer/tools/space-sketch/space-bake';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import type { CommandContext, Workplane } from '@/lib/commands/modeling/types';

export type { Pt };

/** Which wall face a room's outline follows: the room side, the axis, the far side. */
export type RoomBoundary = 'inner' | 'center' | 'outer';

export interface RoomCandidate extends LayoutFace {
  /** Centreline area: the gross floor area. */
  grossArea: number;
  /** Inner-face area: the net floor area. */
  netArea: number;
  /** A point inside the face, for labels and the "already a room" test. */
  interior: Pt;
  /** An IfcSpace on the storey already covers this face. */
  taken: boolean;
  /** The existing room this face is (its outline), which layout edits reshape. */
  room: RoomLink | null;
}

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

/** The outline a room is written with at `boundary`. */
export function roomOutline(room: LayoutFace, boundary: RoomBoundary): Pt[] {
  return boundary === 'inner' ? room.inner : boundary === 'outer' ? room.outer : room.centre;
}

/**
 * A point strictly inside `poly`: its vertex centroid when that is inside (a
 * convex or mildly concave room), else the middle of the widest span of the
 * horizontal line through it (an L- or U-shaped room).
 */
export function interiorPoint(poly: readonly Pt[]): Pt {
  const n = poly.length;
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  const ring = poly as Pt[];
  if (pointInPoly(cx, cy, ring)) return [cx, cy];
  const xs: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > cy) !== (yj > cy)) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best: Pt = [cx, cy], width = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1] - xs[k] > width) { width = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, cy]; }
  }
  return best;
}

/** The smallest room whose centreline outline holds `p` (a room nested in another wins). */
export function roomAt<R extends RoomCandidate>(rooms: readonly R[], p: readonly [number, number]): R | null {
  let hit: R | null = null;
  for (const room of rooms) {
    if (pointInPoly(p[0], p[1], room.centre) && (!hit || room.grossArea < hit.grossArea)) hit = room;
  }
  return hit;
}

/** Layout faces → candidate rooms, `taken` where `occupied`, linked to the `spaces` they are. */
export function roomCandidatesFromFaces(
  faces: readonly LayoutFace[],
  occupied: (p: Pt) => boolean = () => false,
  spaces: readonly SpaceFootprint[] = [],
): RoomCandidate[] {
  const withInterior = faces.map((face) => ({ ...face, interior: interiorPoint(face.inner.length >= 3 ? face.inner : face.centre) }));
  const links = linkFaces(withInterior, spaces as { expressId: number; footprint: Pt[] }[]);
  return withInterior.map((face) => {
    const room = links.get(face.face) ?? null;
    return {
      ...face,
      grossArea: polyArea(face.centre),
      netArea: polyArea(face.inner),
      taken: room !== null || occupied(face.interior),
      room,
    };
  });
}

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
    return !(local && view?.isDeleted(local.expressId));
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

let wallsCache: { meshes: unknown; count: number; version: number; plane: Workplane; storeyId: number; walls: LocalWall[] } | null = null;

/** The storey's walls in its storey-local frame (the last storey's are kept: a layer asks every frame). */
export function storeyWalls(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): LocalWall[] {
  const meshes = s.models.get(modelId)?.geometryResult?.meshes;
  const c = wallsCache;
  if (c && c.meshes === meshes && c.count === (meshes?.length ?? 0) && c.version === s.mutationVersion && c.plane === plane && c.storeyId === storeyId) {
    return c.walls;
  }
  const walls = deriveStoreyWalls(s, modelId, storeyId, plane);
  wallsCache = { meshes, count: meshes?.length ?? 0, version: s.mutationVersion, plane, storeyId, walls };
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

let footprintCache: { store: unknown; version: number; byStorey: Map<number, SpaceFootprint[]> } | null = null;

/** Existing IfcSpaces on the storey with their footprint rings, storey-local. */
export function storeySpaces(s: ViewerState, modelId: string, storeyId: number): SpaceFootprint[] {
  const store = s.models.get(modelId)?.ifcDataStore;
  if (!store) return [];
  if (footprintCache?.store !== store || footprintCache.version !== s.mutationVersion) {
    footprintCache = { store, version: s.mutationVersion, byStorey: existingSpaceFootprintEntriesByStorey(store, s.mutationViews.get(modelId) ?? undefined) };
  }
  return footprintCache.byStorey.get(storeyId) ?? [];
}

/** Existing IfcSpace footprints on the storey, storey-local. */
export function storeySpaceFootprints(s: ViewerState, modelId: string, storeyId: number): Pt[][] {
  return storeySpaces(s, modelId, storeyId).map((e) => e.footprint as Pt[]);
}

interface CacheEntry {
  meshes: readonly MeshData[] | undefined;
  meshCount: number;
  mutationVersion: number;
  head: string;
  layouts: number;
  plane: Workplane;
  storeyId: number;
  modelId: string;
  weld: number;
  result: StoreyRooms;
}

/** One entry: the tool works one storey at a time, and a hover asks every frame. */
let cached: CacheEntry | null = null;

/**
 * The storey's candidate rooms, derived once per wall geometry / edit /
 * workplane / weld and then served from cache. `loading` until the space
 * wasm is initialised (`ensureSpaceWasm`), which the tool starts on launch.
 */
export function storeyRooms(s: ViewerState, modelId: string, storeyId: number, plane: Workplane, weld = DEFAULT_WELD): StoreyRooms {
  if (!spaceWasmLoaded()) return { status: 'loading' };
  const meshes = s.models.get(modelId)?.geometryResult?.meshes;
  const head = undoHead(s, modelId);
  const c = cached;
  if (c && c.meshes === meshes && c.meshCount === (meshes?.length ?? 0) && c.mutationVersion === s.mutationVersion
    && c.head === head && c.layouts === layoutVersion() && c.plane === plane && c.storeyId === storeyId && c.modelId === modelId && c.weld === weld) {
    return c.result;
  }
  const rects = storeyWallRects(s, modelId, storeyId, plane);
  const result: StoreyRooms = rects.length === 0
    ? { status: 'noWalls' }
    : {
      status: 'ready',
      rooms: roomCandidatesFromFaces(layoutFaces(s, modelId, storeyId, weld, rects), storeyOccupancy(s, modelId, storeyId, plane), storeySpaces(s, modelId, storeyId)),
      walls: rects.length,
    };
  cached = { meshes, meshCount: meshes?.length ?? 0, mutationVersion: s.mutationVersion, head, layouts: layoutVersion(), plane, storeyId, modelId, weld, result };
  return result;
}

/** A command session's storey rooms, or null while it has no plane to derive them on. */
export function sessionRooms(ctx: Pick<CommandContext, 'get' | 'modelId' | 'storeyId' | 'workplane'>, weld = DEFAULT_WELD): StoreyRooms | null {
  if (!ctx.workplane || ctx.storeyId === null) return null;
  return storeyRooms(ctx.get(), ctx.modelId, ctx.storeyId, ctx.workplane, weld);
}

/** Forget the cached storey (tests; a closed tool need not keep it). */
export function clearStoreyRoomsCache(): void {
  cached = null;
  footprintCache = null;
  wallsCache = null;
}
