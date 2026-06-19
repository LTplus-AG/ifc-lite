/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live "grab the grip to detach a panel" gesture (#1208), shared by the
 * sidebar pane and the bottom strip.
 *
 * On the first move past the threshold the panel lifts straight out of its dock
 * into a floating window (#1201) positioned exactly where it was, then tracks
 * the cursor for the whole gesture — no disappear-until-drop. Release inside
 * the viewport → it stays floating where dropped; release past the window edge
 * (e.g. dragging onto another monitor) → it hands off to an OS / Picture-in-
 * Picture window. Pointer capture on <body> keeps the gesture alive after the
 * grip's host unmounts and while the cursor leaves the window.
 *
 * The source rect is read from the nearest `[data-detach-root]` ancestor of the
 * grip, so the float starts exactly over the panel it came from.
 */

import { useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { useViewerStore } from '@/store';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { usePanelControls } from './usePanelControls';

const DRAG_THRESHOLD = 5;

function isPointerOutsideWindow(x: number, y: number): boolean {
  return x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
}

export function usePanelDetachDrag(id: WorkspacePanelId): (e: ReactPointerEvent<HTMLElement>) => void {
  const { floatPanel, popOutPanel } = usePanelControls();

  return useCallback(
    (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('[data-chrome-btn]')) return; // skip nested buttons
      e.preventDefault();
      const root = (e.currentTarget as HTMLElement).closest('[data-detach-root]') as HTMLElement | null;
      const rect = root?.getBoundingClientRect();
      // Cap the lifted float to a sane window size — the bottom strip spans the
      // whole viewport width, which would otherwise make a huge full-width float.
      const w = rect ? Math.min(Math.round(rect.width), 720) : 360;
      const h = rect ? Math.min(Math.round(rect.height), 600) : 460;
      const baseX = rect ? rect.left : e.clientX - 40;
      const baseY = rect ? rect.top : e.clientY - 10;
      const startX = e.clientX;
      const startY = e.clientY;
      const pid = e.pointerId;
      let started = false;

      const place = (cx: number, cy: number) => {
        useViewerStore.getState().setFloatingPanelRect(id, {
          x: baseX + (cx - startX),
          y: baseY + (cy - startY),
          w,
          h,
        });
      };

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_THRESHOLD) return;
          started = true;
          floatPanel(id); // lift into a live float, same tick as positioning
          place(ev.clientX, ev.clientY);
          document.body.style.cursor = 'grabbing';
          try { document.body.setPointerCapture(pid); } catch { /* keeps tracking outside the window */ }
        } else {
          place(ev.clientX, ev.clientY);
        }
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        document.body.style.cursor = '';
        try { document.body.releasePointerCapture(pid); } catch { /* noop */ }
        if (started && isPointerOutsideWindow(ev.clientX, ev.clientY)) {
          // Dragged off the window (onto another screen) → hand off to an OS / PiP window.
          useViewerStore.getState().closeFloatingPanel(id);
          popOutPanel(id);
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    },
    [floatPanel, popOutPanel, id],
  );
}
