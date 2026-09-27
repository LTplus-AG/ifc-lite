/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Add Element tool's viewport side: hover preview, the per-type click
 * state machine, and the polygon commit. Split out of `selectionHandlers.ts`.
 *
 * Preview and commit agree by construction (#6233): the hover and every click
 * run the same magnetic raycast, resolve the same storey
 * (`resolveWorkplaneStorey`) and project the snapped point onto that storey's
 * floor (`projectOntoWorkplane`) BEFORE anything is stored, so the ghost is
 * drawn from exactly the points the commit converts.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useViewerStore } from '@/store';
import type { AddElementStoreyRef, AddElementVec3 } from '@/store/slices/addElementSlice';
import { toGlobalIdFromModels } from '@/store/globalId';
import { toast } from '@/components/ui/toast';
import { isRotatedFrame } from '@/lib/authoring/storey-authoring-frame';
import { raycastFloorPlane } from './pick-frame.js';
import {
  authoringFrameFor,
  projectOntoWorkplane,
  rendererPointToIfcStoreyLocal,
  resolveWorkplaneStorey,
  workplaneY,
  type WorkplaneFailure,
} from './add-element-workplane.js';

const SLAB_LIKE = new Set(['slab', 'roof', 'plate', 'space']);

/** Magnetic raycast shared by hover and click, so both see the same snap. */
function pickMagnetic(ctx: MouseHandlerContext, x: number, y: number) {
  const lock = ctx.edgeLockStateRef.current;
  const snap = ctx.snapEnabledRef.current;
  return ctx.renderer.raycastSceneMagnetic(x, y, {
    edge: lock.edge,
    meshExpressId: lock.meshExpressId,
    lockStrength: lock.lockStrength,
  }, {
    hiddenIds: ctx.hiddenEntitiesRef.current,
    isolatedIds: ctx.isolatedEntitiesRef.current,
    snapOptions: { snapToVertices: snap, snapToEdges: snap, snapToFaces: snap, screenSnapRadius: snap ? 40 : 0 },
  });
}

/**
 * Pick under the cursor and land it on the workplane: resolve the storey by
 * the one rule, raycast the scene (or that storey's floor, for empty space),
 * and project the snapped point onto the floor.
 */
function pickOnWorkplane(ctx: MouseHandlerContext, x: number, y: number) {
  const result = pickMagnetic(ctx, x, y);
  const hit = result.snapTarget?.expressId ?? result.intersection?.expressId ?? null;
  const ref = resolveWorkplaneStorey(hit);
  if (typeof ref === 'string') return { result, ref, point: null, snap: null };
  const planeY = workplaneY(ref);
  const raw = result.snapTarget?.position ?? result.intersection?.point ?? raycastFloorPlane(ctx, x, y, planeY);
  if (!raw) return { result, ref, point: null, snap: null };
  const { point, snap } = projectOntoWorkplane({ x: raw.x, y: raw.y, z: raw.z }, planeY);
  return { result, ref, point, snap };
}

/**
 * Live hover preview. Keeps `hoverPoint` equal to whatever the next click
 * would commit. Returns true so the mouse hook can early-out.
 */
export function handleAddElementHover(ctx: MouseHandlerContext, x: number, y: number): boolean {
  if (ctx.measureRaycastPendingRef.current) return true;
  ctx.measureRaycastPendingRef.current = true;
  ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
    ctx.measureRaycastPendingRef.current = false;
    ctx.measureRaycastFrameRef.current = null;
    const { result, point, snap } = pickOnWorkplane(ctx, x, y);
    const store = useViewerStore.getState();
    const previousY = store.addElementHoverPoint?.y;
    store.setAddElementHoverPoint(point, snap);
    // The workplane quad is drawn by the renderer at the hover's height;
    // redraw when the storey under the cursor changes it.
    if (point && point.y !== previousY) ctx.renderer.requestRender();

    // Mirror measure's snap-viz behaviour so vertex/edge/face indicators
    // appear under the cursor with the same UX shape.
    ctx.setSnapTarget(result.snapTarget ?? null);
    if (!result.snapTarget) ctx.clearEdgeLock();
    else if (result.edgeLock.shouldRelease) ctx.clearEdgeLock();
    else if (result.edgeLock.shouldLock && result.edgeLock.edge) {
      ctx.setEdgeLock(result.edgeLock.edge, result.edgeLock.meshExpressId!, result.edgeLock.edgeT);
    }
  });
  return true;
}

function reportWorkplaneFailure(failure: WorkplaneFailure): void {
  toast.error(failure === 'noModel'
    ? "Couldn't add element: no model loaded"
    : "Couldn't add element: model has no IfcBuildingStorey");
}

/** A click with the Add Element tool: pick, lock the gesture's storey, place. */
export function handleAddElementClick(ctx: MouseHandlerContext, x: number, y: number): void {
  const { ref, point } = pickOnWorkplane(ctx, x, y);
  if (typeof ref === 'string') { reportWorkplaneFailure(ref); return; }
  if (!point) return;
  handleAddElementDrop(point, ref);
}

/** Common post-place: pick the new entity's global id, toast, clear pending. */
function finishAddElement(result: { expressId: number } | { error: string }, modelId: string, label: string): void {
  const state = useViewerStore.getState();
  if ('error' in result) {
    toast.error(`Couldn't add ${label.toLowerCase()}: ${result.error}`);
    return;
  }
  state.setSelectedEntityId(toGlobalIdFromModels(state.models, modelId, result.expressId));
  state.clearAddElementPending();
  toast.success(`${label} #${result.expressId} added — undo to remove`);
}

/** Start or extend a multi-click gesture, locking its storey on the first point. */
function appendGesturePoint(point: AddElementVec3, ref: AddElementStoreyRef): void {
  const state = useViewerStore.getState();
  if (!state.addElementGestureStorey) state.setAddElementGestureStorey(ref);
  state.appendAddElementPendingPoint(point);
}

/**
 * Per-type click state machine. `point` is already on `ref`'s workplane.
 *   - column / door / window: 1 click → place
 *   - wall / beam / member: 1st click → start, 2nd click → end + place
 *   - slab-like rectangle: 1st click → corner, 2nd click → opposite + place
 *   - slab-like polygon: N clicks accumulate; Enter / double-click closes
 *     (keyboard layer / add-element-double-click.ts; this only appends)
 */
export function handleAddElementDrop(point: AddElementVec3, ref: AddElementStoreyRef): void {
  const state = useViewerStore.getState();
  const type = state.addElementType;
  const { modelId, storeyId } = ref;

  if (type === 'column') {
    const p = state.addElementColumnParams;
    finishAddElement(state.addColumn(modelId, storeyId, {
      Position: rendererPointToIfcStoreyLocal(point, ref), Width: p.Width, Depth: p.Depth, Height: p.Height,
    }), modelId, 'Column');
    return;
  }
  if (type === 'door') {
    const p = state.addElementDoorParams;
    finishAddElement(state.addDoor(modelId, storeyId, {
      Position: rendererPointToIfcStoreyLocal(point, ref), Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Door');
    return;
  }
  if (type === 'window') {
    // `Position` is the sill-centre, so its storey-local Z is the sill height.
    const p = state.addElementWindowParams;
    finishAddElement(state.addWindow(modelId, storeyId, {
      Position: rendererPointToIfcStoreyLocal(point, ref, p.SillHeight), Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Window');
    return;
  }

  const pending = state.addElementPendingPoints;
  const locked = state.addElementGestureStorey ?? ref;
  if (type === 'wall' || type === 'beam' || type === 'member') {
    if (pending.length === 0) { appendGesturePoint(point, ref); return; }
    const frame = authoringFrameFor(locked);
    const Start = rendererPointToIfcStoreyLocal(pending[0], locked, 0, frame);
    const End = rendererPointToIfcStoreyLocal(point, locked, 0, frame);
    if (type === 'wall') {
      const p = state.addElementWallParams;
      finishAddElement(state.addWall(locked.modelId, locked.storeyId, { Start, End, Thickness: p.Thickness, Height: p.Height }), locked.modelId, 'Wall');
    } else if (type === 'beam') {
      const p = state.addElementBeamParams;
      finishAddElement(state.addBeam(locked.modelId, locked.storeyId, { Start, End, Width: p.Width, Height: p.Height }), locked.modelId, 'Beam');
    } else {
      const p = state.addElementMemberParams;
      finishAddElement(state.addMember(locked.modelId, locked.storeyId, { Start, End, Width: p.Width, Height: p.Height }), locked.modelId, 'Member');
    }
    return;
  }

  if (!SLAB_LIKE.has(type)) return;
  if (state.addElementSlabMode === 'rectangle' && pending.length > 0) {
    commitSlabRectangle(pending[0], point, locked);
    return;
  }
  // First rectangle corner, or another polygon vertex (Enter closes).
  appendGesturePoint(point, ref);
}

/**
 * The rectangle the preview draws is axis-aligned in the MODEL frame. On a
 * storey whose axes are turned against the model's, that rectangle is not
 * axis-aligned storey-locally, so it is written as a polygon of its four
 * corners rather than as a (differently oriented) storey-axis rectangle.
 */
function commitSlabRectangle(a: AddElementVec3, b: AddElementVec3, ref: AddElementStoreyRef): void {
  const state = useViewerStore.getState();
  const type = state.addElementType;
  const frame = authoringFrameFor(ref);
  const corners = [a, { x: b.x, y: a.y, z: a.z }, b, { x: a.x, y: a.y, z: b.z }]
    .map((c) => rendererPointToIfcStoreyLocal(c, ref, 0, frame));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const depth = Math.max(...ys) - Math.min(...ys);
  if (width <= 0 || depth <= 0) {
    toast.error(`${capitalize(type)} corners must span a non-zero rectangle`);
    return;
  }
  if (isRotatedFrame(frame)) {
    commitSlabLike(corners.map((c): [number, number] => [c[0], c[1]]), ref);
    return;
  }
  const Position: [number, number, number] = [Math.min(...xs), Math.min(...ys), 0];
  const { modelId, storeyId } = ref;
  switch (type) {
    case 'slab': finishAddElement(state.addSlab(modelId, storeyId, { Position, Width: width, Depth: depth, Thickness: state.addElementSlabParams.Thickness }), modelId, 'Slab'); return;
    case 'roof': finishAddElement(state.addRoof(modelId, storeyId, { Position, Width: width, Depth: depth, Thickness: state.addElementRoofParams.Thickness }), modelId, 'Roof'); return;
    case 'plate': finishAddElement(state.addPlate(modelId, storeyId, { Position, Width: width, Depth: depth, Thickness: state.addElementPlateParams.Thickness }), modelId, 'Plate'); return;
    case 'space': finishAddElement(state.addSpace(modelId, storeyId, { Position, Width: width, Depth: depth, Height: state.addElementSpaceParams.Height }), modelId, 'Space'); return;
  }
}

/** Write a storey-local polygon profile for the active slab-like type. */
function commitSlabLike(outer: Array<[number, number]>, ref: AddElementStoreyRef): void {
  const state = useViewerStore.getState();
  const { modelId, storeyId } = ref;
  switch (state.addElementType) {
    case 'slab': finishAddElement(state.addSlab(modelId, storeyId, { Profile: 'polygon', OuterCurve: outer, Thickness: state.addElementSlabParams.Thickness }), modelId, 'Slab'); return;
    case 'roof': finishAddElement(state.addRoof(modelId, storeyId, { Profile: 'polygon', OuterCurve: outer, Thickness: state.addElementRoofParams.Thickness }), modelId, 'Roof'); return;
    case 'plate': finishAddElement(state.addPlate(modelId, storeyId, { Profile: 'polygon', OuterCurve: outer, Thickness: state.addElementPlateParams.Thickness }), modelId, 'Plate'); return;
    case 'space': finishAddElement(state.addSpace(modelId, storeyId, { Profile: 'polygon', OuterCurve: outer, Height: state.addElementSpaceParams.Height }), modelId, 'Space'); return;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Signed 2D polygon area via the shoelace formula. */
function polygonArea2D(points: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Close an in-progress polygon for any slab-style type. Enter or double-click.
 * Requires ≥3 points; the builder's auto-closure handles the trailing edge.
 * Commits on the gesture's locked storey — the one its first point used.
 */
export function commitAddElementSlabPolygon(): void {
  const state = useViewerStore.getState();
  if (state.activeTool !== 'addElement') return;
  const type = state.addElementType;
  if (!SLAB_LIKE.has(type) || state.addElementSlabMode !== 'polygon') return;
  const pending = state.addElementPendingPoints;
  if (pending.length < 3) {
    toast.error(`${capitalize(type)} polygon needs at least 3 points`);
    return;
  }
  const ref = state.addElementGestureStorey ?? resolveWorkplaneStorey(null);
  if (typeof ref === 'string') { reportWorkplaneFailure(ref); return; }
  const frame = authoringFrameFor(ref);
  const outer = pending.map((pt): [number, number] => {
    const ifc = rendererPointToIfcStoreyLocal(pt, ref, 0, frame);
    return [ifc[0], ifc[1]];
  });
  // Reject degenerate (zero-area) polygons — repeated or collinear
  // pending points would otherwise produce an OuterCurve that exports
  // as an invalid slab/roof/plate/space profile.
  if (Math.abs(polygonArea2D(outer)) < 1e-6) {
    toast.error(`${capitalize(type)} polygon must have a non-zero area`);
    return;
  }
  commitSlabLike(outer, ref);
}
