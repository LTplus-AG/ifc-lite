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
    const point = result.snapTarget?.position ?? result.intersection?.point ?? null;
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
  const ifc = rendererPointToIfcStoreyLocal(point);
  const type = state.addElementType;

  if (type === 'column') {
    const p = state.addElementColumnParams;
    const result = state.addColumn(modelId, storeyId, {
      Position: ifc,
      Width: p.Width,
      Depth: p.Depth,
      Height: p.Height,
    });
    finishAddElement(result, modelId, 'Column');
    return;
  }

  if (type === 'wall' || type === 'beam') {
    const pending = state.addElementPendingPoints;
    if (pending.length === 0) {
      // Start point — store and wait for end.
      state.appendAddElementPendingPoint({ x: ifc[0], y: ifc[1], z: ifc[2] });
      return;
    }
    // End point — emit.
    const start = pending[0];
    if (type === 'wall') {
      const p = state.addElementWallParams;
      const result = state.addWall(modelId, storeyId, {
        Start: [start.x, start.y, start.z],
        End: ifc,
        Thickness: p.Thickness,
        Height: p.Height,
      });
      finishAddElement(result, modelId, 'Wall');
    } else {
      const p = state.addElementBeamParams;
      const result = state.addBeam(modelId, storeyId, {
        Start: [start.x, start.y, start.z],
        End: ifc,
        Width: p.Width,
        Height: p.Height,
      });
      finishAddElement(result, modelId, 'Beam');
    }
    return;
  }

  if (type === 'slab') {
    if (state.addElementSlabMode === 'rectangle') {
      const pending = state.addElementPendingPoints;
      if (pending.length === 0) {
        state.appendAddElementPendingPoint({ x: ifc[0], y: ifc[1], z: ifc[2] });
        return;
      }
      const corner = pending[0];
      const minX = Math.min(corner.x, ifc[0]);
      const minY = Math.min(corner.y, ifc[1]);
      const width = Math.abs(ifc[0] - corner.x);
      const depth = Math.abs(ifc[1] - corner.y);
      if (width <= 0 || depth <= 0) {
        toast.error("Slab corners must span a non-zero rectangle");
        return;
      }
      const p = state.addElementSlabParams;
      const result = state.addSlab(modelId, storeyId, {
        Position: [minX, minY, 0],
        Width: width,
        Depth: depth,
        Thickness: p.Thickness,
      });
      finishAddElement(result, modelId, 'Slab');
      return;
    }
    // Polygon mode — append; close handled by Enter / double-click.
    state.appendAddElementPendingPoint({ x: ifc[0], y: ifc[1], z: ifc[2] });
    return;
  }
}

/**
 * Close an in-progress slab polygon. Triggered by Enter or
 * double-click. Requires ≥3 points (matches IFC's polygon constraint).
 */
export function commitAddElementSlabPolygon(): void {
  const state = useViewerStore.getState();
  if (state.activeTool !== 'addElement') return;
  if (state.addElementType !== 'slab' || state.addElementSlabMode !== 'polygon') return;
  const pending = state.addElementPendingPoints;
  if (pending.length < 3) {
    toast.error('Slab polygon needs at least 3 points');
    return;
  }
  const ctx = resolveAddElementContext();
  if (!ctx) return;
  const { modelId, storeyId } = ctx;
  const p = state.addElementSlabParams;
  const result = state.addSlab(modelId, storeyId, {
    Profile: 'polygon',
    OuterCurve: pending.map((pt) => [pt.x, pt.y] as [number, number]),
    Thickness: p.Thickness,
  });
  finishAddElement(result, modelId, 'Slab');
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
