/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey workplane (charter #6232, WP2): one invertible map between a
 * storey's own local frame — the frame `addWall` and friends write Start/End
 * in, metres, Z-up — and the render frame the cursor is picked in.
 *
 * local → render, in order:
 *   1. the storey's placement chain in plan (`storeyPlanFrame`: rotation +
 *      origin in the model's world frame, metres);
 *   2. height: the storey floor (`effectiveStoreyElevation`, building-relative
 *      and so already net of the RTC height — see wall-rects-from-meshes.ts)
 *      + the plane offset + local z;
 *   3. the wasm RTC anchor (`wasmRtcOffset`, Z-up) and the Y-up swap, then
 *      `originShift` (Y-up) — the same offsets the loader subtracted;
 *   4. same-CRS federation alignment (the affine baked into the vertices);
 *   5. the model's reposition placement (heading about the pivot, then
 *      translation), which the renderer applies on top of the vertices.
 * A reprojected (proj4) model has no affine inverse and is refused: a wall
 * written through a guessed frame lands turned or offset, and nobody sees it
 * until export. The Add Element tool (`add-element-workplane.ts`) converts
 * through this same map.
 */

import { fromStoreyLocal, toStoreyLocal, type StoreyPlanFrame } from '@ifc-lite/create';
import { storeyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { effectiveStoreyElevation } from '@/components/viewer/add-element-storeys';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint, workspacePointToModelFrame, type PointPlacement } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { invertAffine, applyAffine, sameCrsAlignment, type Affine } from './workplane-alignment.js';
import type { Ray, Vec3, Workplane, WorkplaneSpec } from './types.js';

export interface StoreyWorkplaneFrame {
  modelId: string;
  spec: Extract<WorkplaneSpec, { kind: 'storey' }>;
  plan: StoreyPlanFrame;
  /** Render-frame height of the storey floor. */
  elevation: number;
  coordinateInfo: Pick<CoordinateInfo, 'originShift' | 'wasmRtcOffset'> | undefined;
  /** Same-CRS federation alignment, render frame → federation render frame. */
  alignment: Affine | null;
  placement: PointPlacement;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fromRender = (r: Vec3) => fromRenderTranslation({ x: r[0], y: r[1], z: r[2] });
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The pure composition; `buildStoreyWorkplane` gathers its inputs from the store. */
export function composeStoreyWorkplane(frame: StoreyWorkplaneFrame): Workplane {
  // Render = world − (originShift + RTC) in Y-up axes, from the one shared
  // helper. Height is the exception: storey elevation is building-relative,
  // already net of the RTC anchor's height (rvt01: storey 4.7 m, RTC z 14.73 m,
  // walls rendered at 4.7), so only the origin shift comes off it.
  const offset = totalYupOffset(frame.coordinateInfo);
  const floor = frame.elevation + frame.spec.offset - (frame.coordinateInfo?.originShift?.y ?? 0);
  const inverse = frame.alignment ? invertAffine(frame.alignment) : null;

  const localToRender = (p: Vec3): Vec3 => {
    const [wx, wy] = fromStoreyLocal(frame.plan, [p[0], p[1]]);
    let r: Vec3 = [wx - offset.x, floor + p[2], -wy - offset.z];
    if (frame.alignment) r = applyAffine(frame.alignment, r);
    return toRenderTranslation(modelPointToWorkspacePoint(fromRender(r), frame.placement));
  };

  const renderToLocal = (p: Vec3): Vec3 => {
    let r: Vec3 = toRenderTranslation(workspacePointToModelFrame(fromRender(p), frame.placement));
    if (inverse) r = applyAffine(inverse, r);
    const [x, y] = toStoreyLocal(frame.plan, [r[0] + offset.x, -(r[2] + offset.z)]);
    return [x, y, r[1] - floor];
  };

  const origin = localToRender([0, 0, 0]);
  const u = unit(sub(localToRender([1, 0, 0]), origin));
  const v = unit(sub(localToRender([0, 1, 0]), origin));
  const normal = unit(sub(localToRender([0, 0, 1]), origin));

  return {
    spec: frame.spec,
    modelId: frame.modelId,
    localToRender,
    renderToLocal,
    plane: { origin, normal, u, v },
    intersectRay(ray: Ray) {
      const denom = dot(ray.direction, normal);
      if (Math.abs(denom) < 1e-9) return null;
      const t = dot(sub(origin, ray.origin), normal) / denom;
      if (!(t >= 0) || !Number.isFinite(t)) return null;
      const render: Vec3 = [
        ray.origin[0] + ray.direction[0] * t,
        ray.origin[1] + ray.direction[1] * t,
        ray.origin[2] + ray.direction[2] * t,
      ];
      const local = renderToLocal(render);
      return { local: [local[0], local[1]], render };
    },
  };
}

/** Build `storeyId`'s workplane on `modelId`, or say why it cannot be trusted. */
export function buildStoreyWorkplane(
  s: ViewerState,
  modelId: string,
  storeyId: number,
  offset: number,
): Workplane | { refused: string } {
  const model = s.models.get(modelId);
  const store = model?.ifcDataStore;
  if (!model || !store) return { refused: 'The model has no editable IFC data.' };
  if (model.federationAlignmentStatus === 'reprojected') {
    return { refused: 'This model was reprojected into another CRS; draw in the anchor model instead.' };
  }
  // The storey's plan frame, with #6287's identity fallback: a storey authored
  // this session has no source chain to read, and refusing would block
  // authoring on it outright (`storey-authoring-frame.ts`).
  const { plan } = storeyAuthoringFrame(store, storeyId, undefined);
  let alignment: Affine | null = null;
  let coordinateInfo = model.geometryResult?.coordinateInfo;
  if (model.federationAlignmentStatus === 'same-crs') {
    const aligned = sameCrsAlignment(s, modelId);
    if (!aligned) return { refused: 'This model was realigned to the federation and its alignment cannot be recovered.' };
    alignment = aligned.transform;
    coordinateInfo = aligned.sourceFrame;
  }
  return composeStoreyWorkplane({
    modelId,
    spec: { kind: 'storey', storeyId, offset },
    plan,
    elevation: effectiveStoreyElevation(store, s.mutationViews.get(modelId), storeyId),
    coordinateInfo,
    alignment,
    placement: { translation: displayedTranslation(s.modelPlacement, modelId), rotation: placementFor(s.modelPlacement, modelId).rotation },
  });
}

/**
 * The storey an element sits on, for building its workplane. Authored
 * elements are registered into the live hierarchy when created
 * (`authoredTreeEntry.ts`), and a deleted one cannot be selected or targeted.
 */
export function elementStoreyId(s: ViewerState, modelId: string, expressId: number): number | null {
  // @raw-entity-enumeration-ok point lookup; the hierarchy carries authored elements (authoredTreeEntry.ts)
  return s.models.get(modelId)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(expressId) ?? null;
}

export function isWorkplane(value: Workplane | { refused: string }): value is Workplane {
  return !('refused' in value);
}
