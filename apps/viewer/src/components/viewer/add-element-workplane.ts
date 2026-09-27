/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Add Element tool's WORKPLANE (#6233): which storey a placement authors
 * into, where that storey's floor is on screen, and how a picked point gets
 * from the viewport onto it and into the storey-local frame the builders
 * write.
 *
 * One rule for the storey, shared by hover, every click and the commit:
 *
 *   the storey is resolved at the FIRST click of a gesture — the storey of the
 *   element under the cursor if there is one (smart placement), else the
 *   panel's storey — and locked for the rest of the gesture.
 *
 * Before the first click the hover preview asks the same question the first
 * click will, so what the ghost shows is what the click commits. Previously
 * the fallback floor raycast used the panel storey while smart placement
 * could override it, a two-click element took its storey from the SECOND
 * click only, and the polygon commit ignored inference entirely.
 */

import type { RenderOptions } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { AddElementStoreyRef, AddElementVec3 } from '@/store/slices/addElementSlice';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { modelPlanToStoreyLocal, storeyAuthoringFrame, type StoreyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';
import type { SectionRenderClip } from '@/lib/section/section-render-clip';
import { rendererPointToModelFrame, resolveStoreyExpressId, storeyFloorY } from './pick-frame.js';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/** The panel's target model, else the active one, else the first loaded. */
export function resolveAddElementModelId(state: ViewerState = useViewerStore.getState()): string | null {
  const modelId = state.addElementModelId ?? state.activeModelId;
  if (modelId) return modelId;
  const first = state.models.keys().next();
  return first.done ? null : first.value;
}

/** The storey an entity under the cursor is contained in, federation-aware. */
function storeyOfGlobalId(globalId: number): AddElementStoreyRef | null {
  const state = useViewerStore.getState();
  const local = fromGlobalIdFromModels(state.models, globalId);
  if (!local) return null;
  const storeyId = state.models.get(local.modelId)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(local.expressId);
  return storeyId === undefined ? null : { modelId: local.modelId, storeyId };
}

export type WorkplaneFailure = 'noModel' | 'noStorey';

/**
 * THE storey rule. `hitGlobalId` is the entity under the cursor (or null for
 * empty space). A locked gesture storey wins outright; otherwise the hit's
 * storey, then the panel's, validated against the live storeys.
 */
export function resolveWorkplaneStorey(hitGlobalId: number | null): AddElementStoreyRef | WorkplaneFailure {
  const state = useViewerStore.getState();
  if (state.addElementGestureStorey) return state.addElementGestureStorey;
  const inferred = hitGlobalId !== null ? storeyOfGlobalId(hitGlobalId) : null;
  const modelId = inferred?.modelId ?? resolveAddElementModelId(state);
  if (!modelId) return 'noModel';
  const storeyId = resolveStoreyExpressId(modelId, inferred?.storeyId ?? state.addElementStoreyId);
  return storeyId === null ? 'noStorey' : { modelId, storeyId };
}

/** Renderer Y of a storey's floor — the workplane height. */
export function workplaneY(ref: AddElementStoreyRef): number {
  return storeyFloorY(ref.modelId, ref.storeyId) ?? 0;
}

/**
 * Drop a snapped 3D point straight down (or up) onto the workplane. The XY the
 * user snapped to is kept; the height becomes the storey floor, which is where
 * the commit puts the element. `snap` is the raw point when it was off the
 * plane, for the overlay's drop line.
 */
export function projectOntoWorkplane(
  point: AddElementVec3,
  planeY: number,
): { point: AddElementVec3; snap: AddElementVec3 | null } {
  const projected = { x: point.x, y: planeY, z: point.z };
  return { point: projected, snap: Math.abs(point.y - planeY) > 1e-4 ? { ...point } : null };
}

/** The storey's authoring frame, from the live store. */
export function authoringFrameFor(ref: AddElementStoreyRef): StoreyAuthoringFrame {
  const model = useViewerStore.getState().models.get(ref.modelId);
  return storeyAuthoringFrame(model?.ifcDataStore, ref.storeyId, model?.geometryResult?.coordinateInfo);
}

/**
 * Renderer-frame point → IFC storey-local coordinates for `ref`'s storey:
 * undo the model's reposition (`rendererPointToModelFrame`), then divide the
 * storey's placement chain out (`modelPlanToStoreyLocal`), so a builder that
 * anchors to the storey reads back the point that was clicked. `z` is the
 * storey-local height (0 = on the floor; a window's sill height).
 */
export function rendererPointToIfcStoreyLocal(
  point: AddElementVec3,
  ref: AddElementStoreyRef,
  z = 0,
  frame: StoreyAuthoringFrame = authoringFrameFor(ref),
): [number, number, number] {
  const [mx, my] = rendererPointToModelFrame(point, ref.modelId);
  const [lx, ly] = modelPlanToStoreyLocal(frame, [mx, my]);
  return [lx, ly, z];
}

/**
 * Renderer Y the workplane is drawn at while the tool is active: the locked
 * gesture's floor, else the floor the hover preview sits on, else the panel
 * storey's floor. Null when nothing resolves.
 */
export function activeWorkplaneY(state: ViewerState): number | null {
  if (state.activeTool !== 'addElement') return null;
  const lead = state.addElementPendingPoints[0] ?? state.addElementHoverPoint;
  if (lead) return lead.y;
  const ref = resolveWorkplaneStorey(null);
  return typeof ref === 'string' ? null : workplaneY(ref);
}

/**
 * While Add Element is active, show the drawing plane: the renderer's plane
 * preview (the gridded quad it draws for a section plane that is not cutting)
 * is moved to the workplane height, instead of drawing a second grid. An
 * active cut stays authoritative — nothing about the section changes then.
 */
export function withAddElementWorkplane(state: ViewerState, clip: SectionRenderClip): SectionRenderClip {
  if (clip.sectionPlane?.enabled || clip.clipBox?.enabled) return clip;
  const y = activeWorkplaneY(state);
  if (y === null || !Number.isFinite(y)) return clip;
  const sectionPlane: RenderOptions['sectionPlane'] = { axis: 'down', position: 0, enabled: false, min: y, max: y };
  return { sectionPlane };
}
