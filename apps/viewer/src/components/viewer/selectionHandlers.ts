/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection handler functions extracted from useMouseControls.
 * Handles click/double-click selection and context menu interactions.
 * Pure functions that operate on a MouseHandlerContext — no React dependency.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useViewerStore } from '@/store';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';
import { toast } from '@/components/ui/toast';

/**
 * Handle click event for selection (single click and double click).
 * Manages click timing for double-click detection and Ctrl/Cmd multi-select.
 */
export async function handleSelectionClick(ctx: MouseHandlerContext, e: MouseEvent): Promise<void> {
  const { canvas, renderer, mouseState } = ctx;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const tool = ctx.activeToolRef.current;

  // Skip selection if user was dragging (orbiting/panning)
  if (mouseState.didDrag) {
    return;
  }

  // Skip selection for pan/walk tools - they don't select
  if (tool === 'pan' || tool === 'walk') {
    return;
  }

  // Measure tool now uses drag interaction (see mousedown/mousemove/mouseup)
  if (tool === 'measure') {
    return; // Skip click handling for measure tool
  }

  // Add-element tool — multi-click placement (start→end for walls/beams,
  // corner→opposite for slab rectangle, N+Enter for slab polygon, single
  // for columns). Uses magnetic snap so points lock to vertices/edges
  // when the cursor is near them — same UX as the measure tool.
  if (tool === 'addElement') {
    const currentLock = ctx.edgeLockStateRef.current;
    const result = renderer.raycastSceneMagnetic(x, y, {
      edge: currentLock.edge,
      meshExpressId: currentLock.meshExpressId,
      lockStrength: currentLock.lockStrength,
    }, {
      hiddenIds: ctx.hiddenEntitiesRef.current,
      isolatedIds: ctx.isolatedEntitiesRef.current,
      snapOptions: ctx.snapEnabledRef.current ? {
        snapToVertices: true,
        snapToEdges: true,
        snapToFaces: true,
        screenSnapRadius: 40,
      } : {
        snapToVertices: false,
        snapToEdges: false,
        snapToFaces: false,
        screenSnapRadius: 0,
      },
    });
    const point = result.snapTarget?.position
      ?? result.intersection?.point
      ?? raycastStoreyFloor(ctx, x, y);
    if (!point) return;
    await handleAddElementDrop(point);
    return;
  }

  // Annotate tool — drop a pin at the cursor's world point.
  // Raycasts the scene; if the click misses geometry the draft is
  // not opened (annotations are anchored to surface points by
  // design, not floating in space).
  if (tool === 'annotate') {
    const result = renderer.raycastScene(x, y, ctx.getPickOptions());
    if (!result?.intersection) return;
    const { intersection } = result;
    const store = useViewerStore.getState();
    // Federated models — resolve which model the hit globalId belongs
    // to so the annotation carries enough context to render its
    // popover header. Falls back to (null, expressId) when there's
    // only the legacy single-model state.
    const modelLookup = fromGlobalIdFromModels(store.models, intersection.expressId);
    const modelId = modelLookup?.modelId ?? null;
    const localExpressId = modelLookup?.expressId ?? intersection.expressId;
    store.beginDraft(
      { x: intersection.point.x, y: intersection.point.y, z: intersection.point.z },
      localExpressId ?? null,
      modelId,
    );
    return;
  }

  const now = Date.now();
  const timeSinceLastClick = now - ctx.lastClickTimeRef.current;
  const clickPos = { x, y };
  if (ctx.lastClickPosRef.current &&
    timeSinceLastClick < 300 &&
    Math.abs(clickPos.x - ctx.lastClickPosRef.current.x) < 5 &&
    Math.abs(clickPos.y - ctx.lastClickPosRef.current.y) < 5) {
    const pickOptions = ctx.getPickOptions();
    // Double-click - isolate element
    // Uses visibility filtering so only visible elements can be selected
    const pickResult = await renderer.pick(x, y, pickOptions);
    if (pickResult) {
      ctx.handlePickForSelection(pickResult);
    }
    ctx.lastClickTimeRef.current = 0;
    ctx.lastClickPosRef.current = null;
  } else {
    const pickOptions = ctx.getPickOptions();
    // Single click - uses visibility filtering so only visible elements can be selected
    const pickResult = await renderer.pick(x, y, pickOptions);

    // Multi-selection with Ctrl/Cmd
    if (e.ctrlKey || e.metaKey) {
      if (pickResult) {
        ctx.toggleSelection(pickResult.expressId);
      }
    } else {
      ctx.handlePickForSelection(pickResult);
    }

    ctx.lastClickTimeRef.current = now;
    ctx.lastClickPosRef.current = clickPos;
  }
}

/**
 * Find the first IfcBuildingStorey entity in the active model. Used as a
 * fallback when the user hasn't picked a target storey in the panel.
 */
function firstStoreyExpressId(modelId: string): number | null {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const ids = model?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY');
  return ids && ids.length > 0 ? ids[0] : null;
}

/**
 * Active model resolver — falls back through the same legacy chain
 * the rest of the viewer uses when a single model is loaded.
 */
function resolveActiveModelId(): string | null {
  const state = useViewerStore.getState();
  if (state.activeModelId) return state.activeModelId;
  const first = state.models.keys().next();
  return first.done ? null : first.value;
}

/**
 * Convert a renderer Y-up world point to IFC Z-up storey-local
 * coordinates with Z forced to the storey floor (0). Mirrors the
 * matrix in `packages/renderer/src/pipeline.ts`. Z is clamped so the
 * click landing on a vertical surface doesn't lift the element above
 * the floor — matches construction-tool placement intuition. Refine
 * via the Raw STEP tab if needed.
 */
export function rendererPointToIfcStoreyLocal(point: { x: number; y: number; z: number }): [number, number, number] {
  return [point.x, -point.z, 0];
}

/**
 * Storey-floor ray-plane intersection — used as a fallback when the
 * scene raycast misses every mesh (so the user can place new elements
 * in empty space, not just on existing surfaces). The floor sits at
 * renderer Y = storey elevation; if no storey is selected we use 0
 * (the renderer's default ground plane).
 */
function raycastStoreyFloor(
  ctx: MouseHandlerContext,
  x: number,
  y: number,
): { x: number; y: number; z: number } | null {
  const camera = ctx.renderer.getCamera();
  const canvas = ctx.renderer.getCanvas();
  if (!camera || !canvas) return null;
  const ray = camera.unprojectToRay(x, y, canvas.clientWidth, canvas.clientHeight);
  if (!ray) return null;
  const planeY = resolveStoreyFloorY();
  // Looking down typically means D.y < 0; reject parallel / near-parallel
  // cases so we don't hand back a wildly extrapolated intersection.
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

/**
 * Resolve the renderer Y of the currently selected (or first
 * available) storey's floor. Falls back to 0 when nothing is loaded.
 */
function resolveStoreyFloorY(): number {
  const state = useViewerStore.getState();
  const modelId = state.addElementModelId ?? state.activeModelId;
  if (!modelId) return 0;
  const model = state.models.get(modelId);
  const ds = model?.ifcDataStore;
  if (!ds) return 0;
  const storeyId = state.addElementStoreyId ?? firstStoreyExpressId(modelId);
  if (storeyId === null) return 0;
  return ds.spatialHierarchy?.storeyElevations?.get(storeyId) ?? 0;
}

/**
 * Update the live hover preview for the add-element tool. Runs the
 * same magnetic raycast as the click handler and keeps `hoverPoint`
 * in sync with whatever the next click would place. Used by the
 * 3D-overlay preview so the user sees the in-progress edge / rectangle
 * / polygon segment as they move the cursor.
 *
 * Returns true when handled so the mouse-controls hook can early-out
 * before falling through to the generic hover-tooltip path.
 */
export function handleAddElementHover(ctx: MouseHandlerContext, x: number, y: number): boolean {
  const { renderer } = ctx;
  if (!ctx.measureRaycastPendingRef.current) {
    ctx.measureRaycastPendingRef.current = true;
    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
      ctx.measureRaycastPendingRef.current = false;
      ctx.measureRaycastFrameRef.current = null;

      const currentLock = ctx.edgeLockStateRef.current;
      const result = renderer.raycastSceneMagnetic(x, y, {
        edge: currentLock.edge,
        meshExpressId: currentLock.meshExpressId,
        lockStrength: currentLock.lockStrength,
      }, {
        hiddenIds: ctx.hiddenEntitiesRef.current,
        isolatedIds: ctx.isolatedEntitiesRef.current,
        snapOptions: ctx.snapEnabledRef.current ? {
          snapToVertices: true,
          snapToEdges: true,
          snapToFaces: true,
          screenSnapRadius: 40,
        } : {
          snapToVertices: false,
          snapToEdges: false,
          snapToFaces: false,
          screenSnapRadius: 0,
        },
      });

      const point = result.snapTarget?.position
        ?? result.intersection?.point
        ?? raycastStoreyFloor(ctx, x, y);
      const store = useViewerStore.getState();
      store.setAddElementHoverPoint(point ? { x: point.x, y: point.y, z: point.z } : null);

      // Mirror measure's snap-viz behaviour so vertex/edge/face indicators
      // appear under the cursor with the same UX shape.
      ctx.setSnapTarget(result.snapTarget ?? null);
      if (result.snapTarget) {
        if (result.edgeLock.shouldRelease) {
          ctx.clearEdgeLock();
        } else if (result.edgeLock.shouldLock && result.edgeLock.edge) {
          ctx.setEdgeLock(result.edgeLock.edge, result.edgeLock.meshExpressId!, result.edgeLock.edgeT);
        }
      } else {
        ctx.clearEdgeLock();
      }
    });
  }
  return true;
}

/**
 * Resolve the active model + storey + a snap-aware world point. Surfaces
 * the same toast errors all add-element entry points share.
 */
function resolveAddElementContext(): { modelId: string; storeyId: number } | null {
  const state = useViewerStore.getState();
  const modelId = state.addElementModelId ?? resolveActiveModelId();
  if (!modelId) {
    toast.error("Couldn't add element: no model loaded");
    return null;
  }
  const storeyId = state.addElementStoreyId ?? firstStoreyExpressId(modelId);
  if (storeyId === null) {
    toast.error("Couldn't add element: model has no IfcBuildingStorey");
    return null;
  }
  return { modelId, storeyId };
}

/** Common post-place: pick the new entity's global id, toast, clear pending. */
function finishAddElement(
  result: { expressId: number } | { error: string },
  modelId: string,
  label: string,
): void {
  const state = useViewerStore.getState();
  if ('error' in result) {
    toast.error(`Couldn't add ${label.toLowerCase()}: ${result.error}`);
    return;
  }
  const globalId = toGlobalIdFromModels(state.models, modelId, result.expressId);
  state.setSelectedEntityId(globalId);
  state.clearAddElementPending();
  toast.success(`${label} #${result.expressId} added — undo to remove`);
}

/**
 * Handle a click landing on the scene while the addElement tool is
 * active. Implements a per-type click state machine:
 *
 *   - column: 1 click → place
 *   - wall / beam: 1st click → start, 2nd click → end + place
 *   - slab (rectangle): 1st click → corner, 2nd click → opposite + place
 *   - slab (polygon): N clicks accumulate; Enter / double-click closes
 *     (handled in the keyboard layer; this function only appends)
 */
async function handleAddElementDrop(point: { x: number; y: number; z: number }): Promise<void> {
  const ctx = resolveAddElementContext();
  if (!ctx) return;
  const { modelId, storeyId } = ctx;

  const state = useViewerStore.getState();
  const type = state.addElementType;

  // Single-click placements: column / door / window all drop on one click.
  if (type === 'column') {
    const ifc = rendererPointToIfcStoreyLocal(point);
    const p = state.addElementColumnParams;
    finishAddElement(state.addColumn(modelId, storeyId, {
      Position: ifc, Width: p.Width, Depth: p.Depth, Height: p.Height,
    }), modelId, 'Column');
    return;
  }
  if (type === 'door') {
    const ifc = rendererPointToIfcStoreyLocal(point);
    const p = state.addElementDoorParams;
    finishAddElement(state.addDoor(modelId, storeyId, {
      Position: ifc, Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Door');
    return;
  }
  if (type === 'window') {
    const ifc = rendererPointToIfcStoreyLocal(point);
    const p = state.addElementWindowParams;
    finishAddElement(state.addWindow(modelId, storeyId, {
      Position: ifc, Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Window');
    return;
  }

  if (type === 'wall' || type === 'beam' || type === 'member') {
    const pending = state.addElementPendingPoints;
    if (pending.length === 0) {
      // Start point — store the renderer-frame point and wait for end.
      state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
      return;
    }
    // End point — convert both points to IFC at dispatch time.
    const startIfc = rendererPointToIfcStoreyLocal(pending[0]);
    const endIfc = rendererPointToIfcStoreyLocal(point);
    if (type === 'wall') {
      const p = state.addElementWallParams;
      finishAddElement(state.addWall(modelId, storeyId, {
        Start: startIfc, End: endIfc, Thickness: p.Thickness, Height: p.Height,
      }), modelId, 'Wall');
    } else if (type === 'beam') {
      const p = state.addElementBeamParams;
      finishAddElement(state.addBeam(modelId, storeyId, {
        Start: startIfc, End: endIfc, Width: p.Width, Height: p.Height,
      }), modelId, 'Beam');
    } else {
      // member
      const p = state.addElementMemberParams;
      finishAddElement(state.addMember(modelId, storeyId, {
        Start: startIfc, End: endIfc, Width: p.Width, Height: p.Height,
      }), modelId, 'Member');
    }
    return;
  }

  if (type === 'slab' || type === 'roof' || type === 'plate' || type === 'space') {
    if (state.addElementSlabMode === 'rectangle') {
      const pending = state.addElementPendingPoints;
      if (pending.length === 0) {
        state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
        return;
      }
      const cornerIfc = rendererPointToIfcStoreyLocal(pending[0]);
      const oppositeIfc = rendererPointToIfcStoreyLocal(point);
      const minX = Math.min(cornerIfc[0], oppositeIfc[0]);
      const minY = Math.min(cornerIfc[1], oppositeIfc[1]);
      const width = Math.abs(oppositeIfc[0] - cornerIfc[0]);
      const depth = Math.abs(oppositeIfc[1] - cornerIfc[1]);
      if (width <= 0 || depth <= 0) {
        toast.error(`${capitalize(type)} corners must span a non-zero rectangle`);
        return;
      }
      const position: [number, number, number] = [minX, minY, 0];
      switch (type) {
        case 'slab': {
          const p = state.addElementSlabParams;
          finishAddElement(state.addSlab(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Slab');
          return;
        }
        case 'roof': {
          const p = state.addElementRoofParams;
          finishAddElement(state.addRoof(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Roof');
          return;
        }
        case 'plate': {
          const p = state.addElementPlateParams;
          finishAddElement(state.addPlate(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Plate');
          return;
        }
        case 'space': {
          const p = state.addElementSpaceParams;
          finishAddElement(state.addSpace(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Height: p.Height,
          }), modelId, 'Space');
          return;
        }
      }
    }
    // Polygon mode — append; close handled by Enter.
    state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
    return;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Signed 2D polygon area via the shoelace formula. */
function polygonArea2D(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Close an in-progress polygon for any slab-style type
 * (slab / roof / plate / space). Triggered by Enter. Requires
 * ≥3 points; the builder's auto-closure handles the trailing edge.
 */
export function commitAddElementSlabPolygon(): void {
  const state = useViewerStore.getState();
  if (state.activeTool !== 'addElement') return;
  const type = state.addElementType;
  const polygonable = type === 'slab' || type === 'roof' || type === 'plate' || type === 'space';
  if (!polygonable || state.addElementSlabMode !== 'polygon') return;
  const pending = state.addElementPendingPoints;
  if (pending.length < 3) {
    toast.error(`${capitalize(type)} polygon needs at least 3 points`);
    return;
  }
  const ctx = resolveAddElementContext();
  if (!ctx) return;
  const { modelId, storeyId } = ctx;
  const outer = pending.map((pt) => {
    const ifc = rendererPointToIfcStoreyLocal(pt);
    return [ifc[0], ifc[1]] as [number, number];
  });
  // Reject degenerate (zero-area) polygons — repeated or collinear
  // pending points would otherwise produce an OuterCurve that exports
  // as an invalid slab/roof/plate/space profile.
  if (Math.abs(polygonArea2D(outer)) < 1e-6) {
    toast.error(`${capitalize(type)} polygon must have a non-zero area`);
    return;
  }
  switch (type) {
    case 'slab': {
      const p = state.addElementSlabParams;
      finishAddElement(state.addSlab(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Slab');
      return;
    }
    case 'roof': {
      const p = state.addElementRoofParams;
      finishAddElement(state.addRoof(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Roof');
      return;
    }
    case 'plate': {
      const p = state.addElementPlateParams;
      finishAddElement(state.addPlate(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Plate');
      return;
    }
    case 'space': {
      const p = state.addElementSpaceParams;
      finishAddElement(state.addSpace(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Height: p.Height,
      }), modelId, 'Space');
      return;
    }
  }
}

/**
 * Handle context menu event (right-click).
 * Picks the entity under the cursor and opens the context menu.
 */
export async function handleContextMenu(ctx: MouseHandlerContext, e: MouseEvent): Promise<void> {
  e.preventDefault();
  const { canvas, renderer } = ctx;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // Uses visibility filtering so hidden elements don't appear in context menu
  const pickResult = await renderer.pick(x, y, ctx.getPickOptions());
  ctx.openContextMenu(pickResult?.expressId ?? null, e.clientX, e.clientY);
}
