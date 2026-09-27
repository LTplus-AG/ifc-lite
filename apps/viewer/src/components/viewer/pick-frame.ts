/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewport pick → model-frame plumbing shared by the Split tool, the wall
 * endpoint drag and the Add Element tool. A leaf module (store + placement
 * math only) so `selectionHandlers.ts` and `add-element-handlers.ts` can both
 * import it without importing each other.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useViewerStore } from '@/store';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state.js';
import { fromRenderTranslation } from '@/lib/model-placement/translation.js';
import { workspacePointToModelFrame } from '@/lib/model-placement/rotation.js';
import { effectiveStoreyElevation, selectEffectiveStoreyId } from './add-element-storeys.js';

/**
 * `modelId`'s current reposition placement — translation (including an
 * in-flight move-preview drag, so a pick made mid-drag matches what is on
 * screen) and heading (#4932).
 */
export function pickPlacement(modelId: string): { translation: ReturnType<typeof displayedTranslation>; rotation: ReturnType<typeof placementFor>['rotation'] } {
  const state = useViewerStore.getState();
  return { translation: displayedTranslation(state.modelPlacement, modelId),
    rotation: placementFor(state.modelPlacement, modelId).rotation };
}

/**
 * Convert a renderer Y-up world point — picked against `modelId`'s
 * repositioned geometry — into the model's own IFC Z-up frame, with Z forced
 * to 0. Inverts the model's placement (heading about its pivot, then
 * translation) before the axis swap (#4932).
 *
 * This is the MODEL frame, not a storey-local one: it knows nothing about the
 * storey's placement chain. Builders that anchor to a storey need
 * `rendererPointToIfcStoreyLocal` (`add-element-workplane.ts`), which folds
 * the chain in on top of this.
 */
export function rendererPointToModelFrame(
  point: { x: number; y: number; z: number },
  modelId: string,
): [number, number, number] {
  const modelPoint = workspacePointToModelFrame(fromRenderTranslation(point), pickPlacement(modelId));
  return [modelPoint[0], modelPoint[1], 0];
}

/** Keep `preferred` only while it is a live storey in this model; else the first. */
export function resolveStoreyExpressId(modelId: string, preferred: number | null): number | null {
  const state = useViewerStore.getState();
  const store = state.models.get(modelId)?.ifcDataStore;
  return store ? selectEffectiveStoreyId(store, state.mutationViews.get(modelId), preferred) : null;
}

/**
 * Renderer Y of a storey's floor, offset by the model's own vertical
 * reposition (#4932) — a model moved up or down renders its floor there too.
 * Rotation is a yaw and never tilts the floor, so only the translation's Z
 * applies. Null when the model is not loaded.
 */
export function storeyFloorY(modelId: string, storeyId: number): number | null {
  const state = useViewerStore.getState();
  const ds = state.models.get(modelId)?.ifcDataStore;
  if (!ds) return null;
  const elev = effectiveStoreyElevation(ds, state.mutationViews.get(modelId), storeyId);
  return elev + displayedTranslation(state.modelPlacement, modelId)[2];
}

/**
 * Horizontal ray-plane intersection at renderer Y = `planeY` — the fallback
 * when the scene raycast misses every mesh, so a click in empty space still
 * lands on a floor.
 */
export function raycastFloorPlane(
  ctx: MouseHandlerContext,
  x: number,
  y: number,
  planeY: number,
): { x: number; y: number; z: number } | null {
  const camera = ctx.renderer.getCamera();
  const canvas = ctx.renderer.getCanvas();
  if (!camera || !canvas) return null;
  // x/y arrive in CSS space (handleSelectionClick subtracts the
  // bounding-rect origin). `unprojectToRay` expects drawing-buffer
  // coords, which differ from CSS by DPR. Convert both the cursor
  // and the canvas size so the ray is computed in the same space
  // `projectToScreen` writes to — otherwise pick drifts at DPR ≠ 1.
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? (x / rect.width) * canvas.width : x;
  const sy = rect.height > 0 ? (y / rect.height) * canvas.height : y;
  const ray = camera.unprojectToRay(sx, sy, canvas.width, canvas.height);
  if (!ray) return null;
  // Reject parallel / near-parallel rays so we don't hand back a wildly
  // extrapolated intersection.
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (!Number.isFinite(t) || t <= 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}
