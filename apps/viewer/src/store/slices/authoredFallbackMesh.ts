/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An added element always ends up with a mesh (#6232).
 *
 * The wasm re-mesh of the written IFC is the geometry truth, but it can
 * decline: a model with no STEP source (IFCX), one loaded without the engine's
 * coordinate frame, a subgraph it cannot read, a frame it cannot align, or a
 * worker that fails or times out. An element added there must not stay
 * invisible until a reload, so when the re-mesh leaves a live added element
 * with no mesh, the element is drawn from the parameters it was built with
 * (`buildElementMesh`, the same builder the gesture ghosts use), and that mesh
 * is what the room receives.
 *
 * The parameters are remembered per loaded model, so a redo that finds no
 * stashed mesh (the element was undone before its mesh landed) takes the same
 * path and draws the same thing.
 */

import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import type { AuthoredElement } from './authoredElement.js';
import { profileSectionExtent } from '@ifc-lite/create';
import { buildElementMesh, type ElementMeshPayload } from './addElementMeshes.js';
import { authoredDataStore } from './authoredTreeEntry.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { requestRemesh, type RemeshOutcome } from '@/lib/remesh/remesh-service';
import { storeyAuthoringFrame, storeyLocalToModelPlan, type StoreyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';

type Vec3 = [number, number, number];
type Get = () => ViewerState;
interface Fallback { storeyExpressId: number; element: AuthoredElement }

/** Per loaded model (its data store), per model-local express id. */
const fallbacks = new WeakMap<IfcDataStore, Map<number, Fallback>>();

/** Remember what `entityId` was built from, for {@link remeshAuthoredElement}. */
export function rememberAuthoredElement(dataStore: IfcDataStore, entityId: number, storeyExpressId: number, element: AuthoredElement): void {
  let byId = fallbacks.get(dataStore);
  if (!byId) fallbacks.set(dataStore, (byId = new Map()));
  byId.set(entityId, { storeyExpressId, element });
}

/**
 * Re-mesh an added element through the wasm mesher, and draw it from its
 * parameters when that leaves it without a mesh. Resolves once it has one (or
 * is gone). Returns the re-mesh outcome, and whether the fallback was drawn.
 */
export async function remeshAuthoredElement(get: Get, modelId: string, entityId: number): Promise<{ outcome: RemeshOutcome; fallback: boolean }> {
  const outcome = await requestRemesh(get, modelId, [entityId], 'created');
  const state = get();
  const dataStore = authoredDataStore(state, modelId);
  const remembered = dataStore ? fallbacks.get(dataStore)?.get(entityId) : undefined;
  if (!dataStore || !remembered || !isLiveWithoutMesh(state, modelId, entityId)) return { outcome, fallback: false };
  const mesh = buildElementMesh({
    type: remembered.element.kind,
    globalId: toGlobalIdFromModels(state.models, modelId, entityId),
    storeyElevation: dataStore.spatialHierarchy?.storeyElevations?.get(remembered.storeyExpressId) ?? 0,
    payload: authoredElementMeshPayload(
      remembered.element,
      storeyAuthoringFrame(dataStore, remembered.storeyExpressId, coordinateInfoOf(state, modelId)),
    ),
  });
  if (!mesh) return { outcome, fallback: false };
  appendAuthoredMesh(state, modelId, mesh);
  state.mirrorEntityGeometry(modelId, entityId, [mesh]);
  return { outcome, fallback: true };
}

function coordinateInfoOf(state: ViewerState, modelId: string): CoordinateInfo | undefined {
  return (state.models.get(modelId)?.geometryResult ?? (state.models.size === 0 ? state.geometryResult : null))?.coordinateInfo;
}

function isLiveWithoutMesh(state: ViewerState, modelId: string, entityId: number): boolean {
  const view = state.mutationViews.get(modelId);
  if (!view?.getNewEntity(entityId) || view.getTombstones().has(entityId)) return false;
  const globalId = toGlobalIdFromModels(state.models, modelId, entityId);
  const meshes = (state.models.get(modelId)?.geometryResult ?? (state.models.size === 0 ? state.geometryResult : null))?.meshes ?? [];
  return !meshes.some((mesh) => mesh.expressId === globalId);
}

/**
 * Put an authored element's mesh on screen. `appendGeometryBatch` only routes
 * to a known model or the active one, and legacy mode has neither, so there
 * the top-level geometry is extended directly.
 */
function appendAuthoredMesh(state: ViewerState, modelId: string, mesh: MeshData): void {
  if (state.models.size > 0 || !state.geometryResult) {
    state.appendGeometryBatch(modelId, [mesh]);
    return;
  }
  const g = state.geometryResult;
  state.setGeometryResult({
    ...g,
    meshes: [...g.meshes, mesh],
    totalTriangles: g.totalTriangles + mesh.indices.length / 3,
    totalVertices: g.totalVertices + mesh.positions.length / 3,
  });
}

/**
 * The renderer-frame mesh description for an authored element. Builder params
 * are STOREY-LOCAL, so every point is folded through the storey's chain
 * (`frame`) back into the model frame the mesh is drawn in, or an element
 * authored on a storey away from the model origin draws a whole storey offset
 * away from where it will reload (#6233).
 */
export function authoredElementMeshPayload(element: AuthoredElement, frame?: StoreyAuthoringFrame): ElementMeshPayload {
  const at = (p: Vec3): Vec3 => {
    if (!frame) return p;
    const [x, y] = storeyLocalToModelPlan(frame, [p[0], p[1]]);
    return [x, y, p[2]];
  };
  const payload = storeyLocalPayload(element);
  switch (payload.type) {
    case 'wall': case 'beam': case 'member':
      return { ...payload, start: at(payload.start), end: at(payload.end) };
    case 'column': {
      if (!payload.refDirection || !frame) return { ...payload, position: at(payload.position) };
      // A direction maps as the difference of two mapped points (the storey frame may turn it).
      const o = at([0, 0, 0]), d = at([payload.refDirection[0], payload.refDirection[1], 0]);
      return { ...payload, position: at(payload.position), refDirection: [d[0] - o[0], d[1] - o[1]] };
    }
    case 'door': case 'window':
      return { ...payload, position: at(payload.position) };
    default:
      return { ...payload, corners: payload.corners.map(at) };
  }
}

function storeyLocalPayload(element: AuthoredElement): ElementMeshPayload {
  switch (element.kind) {
    case 'column': {
      const p = element.params;
      const [Width, Depth] = 'Profile' in p ? profileSectionExtent(p.Profile) : [p.Width, p.Depth];
      return {
        type: 'column', params: { Width, Depth, Height: p.Height }, position: p.Position,
        ...(p.RefDirection ? { refDirection: [p.RefDirection[0], p.RefDirection[1]] as const } : {}),
      };
    }
    case 'wall': {
      const p = element.params;
      return { type: 'wall', params: { Thickness: p.Thickness, Height: p.Height }, start: p.Start, end: p.End };
    }
    // The builders centre the section on Start-End; the box grows up from
    // its segment, so it starts half the section height below the axis. A
    // profiled section draws as its bounding box.
    case 'beam': case 'member': {
      const p = element.params;
      const [Width, Height] = 'Profile' in p ? profileSectionExtent(p.Profile) : [p.Width, p.Height];
      const down = (q: Vec3): Vec3 => [q[0], q[1], q[2] - Height / 2];
      return { type: element.kind, params: { Width, Height }, start: down(p.Start), end: down(p.End) };
    }
    case 'door': {
      const p = element.params;
      return { type: 'door', params: { Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness ?? 0.05 }, position: p.Position };
    }
    case 'window': {
      const p = element.params;
      return { type: 'window', params: { Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness ?? 0.05 }, position: p.Position };
    }
    case 'slab':
      return { type: 'slab', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCorners(element.params) };
    case 'space':
      return { type: 'space', params: { Width: 0, Depth: 0, Height: element.params.Height }, corners: profileCorners(element.params) };
    case 'roof':
      return { type: 'roof', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCorners(element.params) };
    case 'plate':
      return { type: 'plate', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCorners(element.params) };
  }
}

/**
 * The corner ring of a slab / roof / plate / space in rectangle or polygon
 * mode: rectangle = 4 corners CCW from `Position` + Width/Depth; polygon =
 * the `OuterCurve` lifted to 3D at the profile's z.
 */
function profileCorners(
  params:
    | { Profile?: 'rectangle'; Position: [number, number, number]; Width: number; Depth: number }
    | { Profile: 'polygon'; OuterCurve: Array<[number, number]>; Position?: [number, number, number] },
): Array<[number, number, number]> {
  const z = ('Position' in params ? params.Position?.[2] : 0) ?? 0;
  if ('Profile' in params && params.Profile === 'polygon') return params.OuterCurve.map(([x, y]): Vec3 => [x, y, z]);
  const rect = params as { Position: [number, number, number]; Width: number; Depth: number };
  const [px, py, pz] = rect.Position;
  return [[px, py, pz], [px + rect.Width, py, pz], [px + rect.Width, py + rect.Depth, pz], [px, py + rect.Depth, pz]];
}
