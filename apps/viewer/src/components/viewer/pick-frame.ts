/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewport pick plumbing for the Add Element tool: storey resolution, floor
 * heights and the empty-space floor raycast. Picks convert to storey-local
 * through the storey workplane (`lib/commands/modeling/workplane.ts`).
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useViewerStore } from '@/store';
import { displayedTranslation } from '@/lib/model-placement/state.js';
import { effectiveStoreyElevation, selectEffectiveStoreyId } from './add-element-storeys.js';

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
