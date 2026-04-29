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

  // Add-element tool — drop a wall/slab/beam/column at the cursor's
  // world point. Mirrors the annotate flow: raycasts the scene; if
  // the click misses geometry we silently no-op (no floating
  // elements). The renderer is Y-up, IFC is Z-up — convert as we
  // hand off to the storey-local builders.
  if (tool === 'addElement') {
    const result = renderer.raycastScene(x, y, ctx.getPickOptions());
    if (!result?.intersection) return;
    await handleAddElementDrop(result.intersection.point);
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
 * Handle a click landing on the scene while the addElement tool is
 * active. Reads the panel state from the store, converts the click
 * point from renderer Y-up to IFC Z-up storey-local (Z forced to 0 so
 * the element always sits on the storey floor — users can refine via
 * Raw STEP), then dispatches the matching builder action.
 */
async function handleAddElementDrop(point: { x: number; y: number; z: number }): Promise<void> {
  const state = useViewerStore.getState();
  const modelId = state.addElementModelId ?? resolveActiveModelId();
  if (!modelId) {
    toast.error("Couldn't add element: no model loaded");
    return;
  }

  const storeyId = state.addElementStoreyId ?? firstStoreyExpressId(modelId);
  if (storeyId === null) {
    toast.error("Couldn't add element: model has no IfcBuildingStorey");
    return;
  }

  // Renderer Y-up → IFC Z-up conversion (mirrors the matrix in
  // packages/renderer/src/pipeline.ts). Z forced to 0 so the element
  // sits on the storey floor; the click landing on a vertical surface
  // higher up doesn't lift the element along Z (matches how
  // construction-tool placement actually feels).
  const ifcX = point.x;
  const ifcY = -point.z;
  const start: [number, number, number] = [ifcX, ifcY, 0];

  const type = state.addElementType;
  let result: { expressId: number } | { error: string };
  let label: string;

  switch (type) {
    case 'wall': {
      const p = state.addElementWallParams;
      result = state.addWall(modelId, storeyId, {
        Start: start,
        End: [start[0] + p.Length, start[1], start[2]],
        Thickness: p.Thickness,
        Height: p.Height,
      });
      label = 'Wall';
      break;
    }
    case 'slab': {
      const p = state.addElementSlabParams;
      result = state.addSlab(modelId, storeyId, {
        Position: start,
        Width: p.Width,
        Depth: p.Depth,
        Thickness: p.Thickness,
      });
      label = 'Slab';
      break;
    }
    case 'beam': {
      const p = state.addElementBeamParams;
      result = state.addBeam(modelId, storeyId, {
        Start: start,
        End: [start[0] + p.Length, start[1], start[2]],
        Width: p.Width,
        Height: p.Height,
      });
      label = 'Beam';
      break;
    }
    case 'column': {
      const p = state.addElementColumnParams;
      result = state.addColumn(modelId, storeyId, {
        Position: start,
        Width: p.Width,
        Depth: p.Depth,
        Height: p.Height,
      });
      label = 'Column';
      break;
    }
  }

  if ('error' in result) {
    toast.error(`Couldn't add ${label.toLowerCase()}: ${result.error}`);
    return;
  }

  // Federation-aware: select the new entity by its global id so the
  // 3D viewport can flash it into focus.
  const globalId = toGlobalIdFromModels(state.models, modelId, result.expressId);
  state.setSelectedEntityId(globalId);
  toast.success(`${label} #${result.expressId} added — undo to remove`);
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
