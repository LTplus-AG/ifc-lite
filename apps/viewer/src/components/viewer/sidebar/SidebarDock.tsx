/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's right region (#1208): a VS Code-style activity bar + a
 * resizable docked content pane.
 *
 * Two modes (persisted in `sidebarSlice`):
 *   - `expanded`  — content pane + activity bar (the content pane is resizable).
 *   - `collapsed` — activity bar only (icons); clicking an icon re-expands.
 *
 * The activity-bar rail is ALWAYS visible — it is the always-available entry
 * point to every panel, so there is no "fully hidden" state. The content pane
 * width is stored as a % of the main row so it survives reloads and travels
 * with a Flavor; while dragging we hold a local % to avoid writing localStorage
 * on every mouse move.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { ActivityBar } from './ActivityBar';
import { SidebarPanelHost } from './SidebarPanelHost';

const ACTIVITY_BAR_PX = 48; // w-12
// Mirrors the clamp in sidebarSlice so the live drag matches what is persisted.
const MIN_WIDTH_PCT = 14;
const MAX_WIDTH_PCT = 60;

export function SidebarDock() {
  const mode = useViewerStore((s) => s.sidebarMode);
  const widthPct = useViewerStore((s) => s.sidebarWidthPct);
  const setSidebarWidthPct = useViewerStore((s) => s.setSidebarWidthPct);

  const rootRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [dragPct, setDragPct] = useState<number | null>(null);
  // Teardown for an in-flight resize, so a mid-drag unmount (viewport mode
  // switch) doesn't leak document listeners + a stuck body userSelect (#1208).
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // Measure the parent row so we can turn the persisted % into a pixel width
  // without a circular width dependency.
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const update = () => setRowWidth(parent.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [mode]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const parent = rootRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const move = (ev: MouseEvent) => {
        // The content pane's right edge is fixed against the activity bar;
        // dragging its left edge sets the width. Clamp live to the same range
        // the store enforces so the pane doesn't rubber-band past the limits.
        const contentPx = rect.right - ACTIVITY_BAR_PX - ev.clientX;
        const pct = (contentPx / rect.width) * 100;
        setDragPct(Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, pct)));
      };
      const teardown = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        resizeCleanupRef.current = null;
      };
      const up = () => {
        teardown();
        setDragPct((pct) => {
          if (pct !== null) setSidebarWidthPct(pct);
          return null;
        });
      };
      resizeCleanupRef.current = teardown;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setSidebarWidthPct],
  );

  const effectivePct = dragPct ?? widthPct;
  const contentPx = rowWidth > 0 ? Math.round((rowWidth * effectivePct) / 100) : undefined;

  return (
    <div ref={rootRef} className="flex h-full shrink-0">
      {mode === 'expanded' && (
        <>
          {/* Resize handle */}
          <div
            onMouseDown={onResizeStart}
            className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
          />
          <div
            className="h-full min-w-0 overflow-hidden panel-container"
            style={{ width: contentPx ?? `${effectivePct}%` }}
          >
            <SidebarPanelHost />
          </div>
        </>
      )}
      <ActivityBar />
    </div>
  );
}
