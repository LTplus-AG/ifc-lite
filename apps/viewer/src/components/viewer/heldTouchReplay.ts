/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { isGeometryHeld } from '@/lib/pick-gating';
import { queueHeldPointerClick } from './heldPointerQueue.js';
import { handleSelectionClick } from './selectionHandlers.js';
import { viewportHandlerContext } from './touchRouting.js';
import { routeToolTap } from './toolTap.js';

export function queueHeldTouchTap(canvas: HTMLCanvasElement, x: number, y: number, tool: string,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): boolean {
  if (!isGeometryHeld(useViewerStore.getState())) return false;
  const ctx = viewportHandlerContext(canvas);
  if (!ctx) return false;
  queueHeldPointerClick({ x, y, shiftKey: modifiers.shiftKey === true, ctrlKey: modifiers.ctrlKey === true,
    metaKey: modifiers.metaKey === true, altKey: modifiers.altKey === true, button: 0,
    handler: `touch:${tool}`, replay: () => {
      if (ctx.activeToolRef.current !== tool) return;
      const rect = canvas.getBoundingClientRect();
      if (tool !== 'select' && tool !== 'measure' && routeToolTap(ctx, tool, x, y)) return;
      void handleSelectionClick(ctx, new MouseEvent('click', { bubbles: true, clientX: rect.left + x, clientY: rect.top + y,
        button: 0, detail: 1, shiftKey: modifiers.shiftKey, ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey, altKey: modifiers.altKey }));
    } });
  return true;
}
