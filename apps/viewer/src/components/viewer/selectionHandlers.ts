/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection handler functions extracted from useMouseControls.
 * Handles click/double-click selection and context menu interactions.
 * Pure functions that operate on a MouseHandlerContext — no React dependency.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { positionFromPoint } from '@ifc-lite/renderer';

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

  // Section-tool face-pick: click any visible face and the plane is set
  // through it. Intercept before the generic select path so the click
  // doesn't also flip selection.
  if (tool === 'section' && ctx.sectionPickModeRef.current) {
    const hit = renderer.raycastScene(x, y, {
      hiddenIds: ctx.hiddenEntitiesRef.current,
      isolatedIds: ctx.isolatedEntitiesRef.current,
    });
    if (hit?.intersection) {
      const n = hit.intersection.normal;
      const p = hit.intersection.point;
      // Normalise and map the pick point into 0-100% along the model's
      // bounds projected onto the plane normal — this is what the
      // position slider drives, so after the pick dragging the slider
      // offsets the plane along its normal continuously. Shared helper
      // so the mapping stays in lockstep with the renderer's clip.
      const nlen = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      if (nlen > 1e-6) {
        const unit: [number, number, number] = [n.x / nlen, n.y / nlen, n.z / nlen];
        const bounds = renderer.getModelBounds();
        const position = bounds
          ? positionFromPoint(bounds, unit, [p.x, p.y, p.z])
          : 50;
        ctx.setSectionPlaneFromFace(unit, position);
      } else {
        ctx.setSectionPickMode(false);
      }
    } else {
      // Missed geometry — cancel the arm so the user isn't stuck in pick
      // mode after an errant background click.
      ctx.setSectionPickMode(false);
    }
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
