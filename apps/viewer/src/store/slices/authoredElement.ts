/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The elements the `@ifc-lite/create` in-store builders make, and the
 * renderer-frame mesh each one is mirrored with. Shared by the UI add actions
 * and the SDK `bim.store.add*` adapter so both draw the same thing.
 */

import type {
  BeamInStoreParams,
  ColumnInStoreParams,
  DoorInStoreParams,
  MemberInStoreParams,
  PlateInStoreParams,
  RoofInStoreParams,
  SlabInStoreParams,
  SpaceInStoreParams,
  WallInStoreParams,
  WindowInStoreParams,
} from '@ifc-lite/create';
import type { ElementMeshPayload } from './addElementMeshes.js';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { storeyAuthoringFrame, storeyLocalToModelPlan, type StoreyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';

type Vec3 = [number, number, number];

/** An element one of the `@ifc-lite/create` in-store builders makes, with the params it took. */
export type AuthoredElement =
  | { kind: 'column'; params: ColumnInStoreParams }
  | { kind: 'wall'; params: WallInStoreParams }
  | { kind: 'slab'; params: SlabInStoreParams }
  | { kind: 'beam'; params: BeamInStoreParams }
  | { kind: 'door'; params: DoorInStoreParams }
  | { kind: 'window'; params: WindowInStoreParams }
  | { kind: 'space'; params: SpaceInStoreParams; previewCorners?: Array<[number, number]> }
  | { kind: 'roof'; params: RoofInStoreParams }
  | { kind: 'plate'; params: PlateInStoreParams }
  | { kind: 'member'; params: MemberInStoreParams };

/**
 * The renderer-frame mesh description for an authored element. Builder params
 * are STOREY-LOCAL, so every point is folded through the storey's chain
 * (`frame`) back into the model frame the mesh is drawn in — otherwise an
 * element authored on a storey that does not sit at the model origin draws a
 * whole storey offset away from where it will reload (#6233).
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
    case 'column': case 'door': case 'window':
      return { ...payload, position: at(payload.position) };
    default:
      // Space Sketch's `previewCorners` are already in the model frame.
      if (element.kind === 'space' && element.previewCorners) return payload;
      return { ...payload, corners: payload.corners.map(at) };
  }
}

/** {@link authoredElementMeshPayload} on `storeyExpressId`'s authoring frame. */
export function authoredElementMeshPayloadOnStorey(
  element: AuthoredElement,
  store: IfcDataStore,
  storeyExpressId: number,
  coordinateInfo: CoordinateInfo | undefined,
): ElementMeshPayload {
  return authoredElementMeshPayload(element, storeyAuthoringFrame(store, storeyExpressId, coordinateInfo));
}

function storeyLocalPayload(element: AuthoredElement): ElementMeshPayload {
  switch (element.kind) {
    case 'column': {
      const p = element.params;
      return { type: 'column', params: { Width: p.Width, Depth: p.Depth, Height: p.Height }, position: p.Position };
    }
    case 'wall': {
      const p = element.params;
      return { type: 'wall', params: { Thickness: p.Thickness, Height: p.Height }, start: p.Start, end: p.End };
    }
    case 'beam': {
      const p = element.params;
      return { type: 'beam', params: { Width: p.Width, Height: p.Height }, start: p.Start, end: p.End };
    }
    case 'member': {
      const p = element.params;
      return { type: 'member', params: { Width: p.Width, Height: p.Height }, start: p.Start, end: p.End };
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
      return { type: 'slab', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCornersFromParams(element.params) };
    case 'space':
      return { type: 'space', params: { Width: 0, Depth: 0, Height: element.params.Height }, corners: profileCornersFromParams(element.params, element.previewCorners) };
    case 'roof':
      return { type: 'roof', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCornersFromParams(element.params) };
    case 'plate':
      return { type: 'plate', params: { Width: 0, Depth: 0, Thickness: element.params.Thickness }, corners: profileCornersFromParams(element.params) };
  }
}

/**
 * Build the polygon corner ring used by slab/roof/plate/space mesh
 * previews from a builder param object that may be in rectangle or
 * polygon mode. Rectangle = 4 corners CCW from `Position` +
 * Width/Depth; polygon = the `OuterCurve` lifted to 3D at z = 0.
 */
function profileCornersFromParams(
  params:
    | { Profile?: 'rectangle'; Position: [number, number, number]; Width: number; Depth: number }
    | { Profile: 'polygon'; OuterCurve: Array<[number, number]>; Position?: [number, number, number] },
  /** Plan outline to draw the 3D mirror at INSTEAD of the profile, for a caller
   *  whose profile is not in the frame `buildElementMesh` renders in — Space
   *  Sketch is the one, and `useSpaceBake` says why. */
  previewCorners?: Array<[number, number]>,
): Array<[number, number, number]> {
  const z = ('Position' in params ? params.Position?.[2] : 0) ?? 0;
  const plan = previewCorners
    ?? ('Profile' in params && params.Profile === 'polygon' ? params.OuterCurve : null);
  if (plan) return plan.map(([x, y]): [number, number, number] => [x, y, z]);
  const rect = params as { Position: [number, number, number]; Width: number; Depth: number };
  const [px, py, pz] = rect.Position;
  return [[px, py, pz], [px + rect.Width, py, pz],
    [px + rect.Width, py + rect.Depth, pz], [px, py + rect.Depth, pz]];
}
