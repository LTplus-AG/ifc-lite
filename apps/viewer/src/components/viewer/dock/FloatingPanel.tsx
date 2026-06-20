/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A floating / edge-snapped workspace-panel window (issue #1201).
 *
 * Chrome around an arbitrary panel: a drag-by-header title bar, dock controls
 * (snap left / right / bottom / free-float, re-dock into the right slot, close)
 * and a resize affordance. Geometry lives in the dock slice so it persists and
 * survives re-render; this component only translates pointer gestures into
 * `setFloatingPanelRect` / `snapFloatingPanel` calls.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import {
  PanelLeft,
  PanelRight,
  PanelBottom,
  Square,
  Pin,
  X,
  GripVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FloatingPanelState, SnapZone } from '@/store';
import { computeFloatingPanelStyle, type SnapBounds } from './floating-panel-geometry';

export type { SnapBounds };

const MIN_W = 260;
const MIN_H = 180;
// Keep the opposite edge / header reachable when resizing against the viewport.
const RESIZE_EDGE_MARGIN = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface FloatingPanelProps {
  panel: FloatingPanelState;
  title: string;
  zIndex: number;
  /** The viewport region edge snaps confine to; null until measured. */
  bounds: SnapBounds | null;
  children: ReactNode;
  onRect: (rect: Partial<Pick<FloatingPanelState, 'x' | 'y' | 'w' | 'h'>>) => void;
  onSnap: (snap: SnapZone) => void;
  onFocus: () => void;
  /** Re-dock into the right slot (stop floating, show docked). */
  onDock: () => void;
  onClose: () => void;
}

export function FloatingPanel({
  panel,
  title,
  zIndex,
  bounds,
  children,
  onRect,
  onSnap,
  onFocus,
  onDock,
  onClose,
}: FloatingPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Tear down any in-flight drag / resize listeners if the panel unmounts mid-
  // gesture (closed / docked while dragging) so stale window listeners don't
  // keep firing onRect for a panel that no longer exists (#1208).
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => gestureCleanupRef.current?.(), []);

  // Drag by the header: snapped windows convert to free-float at their current
  // on-screen rect first, so they don't jump.
  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, [data-no-drag]')) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    onFocus();

    const rect = el.getBoundingClientRect();
    const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const startX = rect.left - (parent?.left ?? 0);
    const startY = rect.top - (parent?.top ?? 0);
    const w = rect.width;
    const h = rect.height;
    const maxX = Math.max(0, (el.offsetParent as HTMLElement | null ? (el.offsetParent as HTMLElement).clientWidth : window.innerWidth) - w);
    const maxY = Math.max(0, (el.offsetParent as HTMLElement | null ? (el.offsetParent as HTMLElement).clientHeight : window.innerHeight) - h);
    const px = e.clientX;
    const py = e.clientY;
    if (panel.snap !== 'free') onSnap('free');
    onRect({ x: startX, y: startY, w, h });

    const move = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(maxX, startX + ev.clientX - px));
      const y = Math.max(0, Math.min(maxY, startY + ev.clientY - py));
      onRect({ x, y });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      gestureCleanupRef.current = null;
    };
    gestureCleanupRef.current = up;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Resize: free → bottom-right corner; left/right snap → inner edge (width);
  // bottom snap → top edge (height).
  const onResizeStart = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    const rect = el.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    const px = e.clientX;
    const py = e.clientY;
    const snap = panel.snap;
    // Clamp growth so a snapped panel can't be dragged past its dock region
    // (header / inner edge becoming unreachable). Free panels clamp to the
    // window; edge-snapped panels clamp to the viewport region (#1208 / #1245).
    const maxW = snap === 'free'
      ? Math.max(MIN_W, window.innerWidth - RESIZE_EDGE_MARGIN)
      : Math.max(MIN_W, bounds?.width ?? window.innerWidth);
    const maxH = snap === 'free'
      ? Math.max(MIN_H, window.innerHeight - RESIZE_EDGE_MARGIN)
      : Math.max(MIN_H, bounds?.height ?? window.innerHeight);

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - px;
      const dy = ev.clientY - py;
      if (snap === 'bottom') {
        onRect({ h: clamp(startH - dy, MIN_H, maxH) });
      } else if (snap === 'right') {
        onRect({ w: clamp(startW - dx, MIN_W, maxW) });
      } else if (snap === 'left') {
        onRect({ w: clamp(startW + dx, MIN_W, maxW) });
      } else {
        onRect({ w: clamp(startW + dx, MIN_W, maxW), h: clamp(startH + dy, MIN_H, maxH) });
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      gestureCleanupRef.current = null;
    };
    gestureCleanupRef.current = up;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const snapBtn = (zone: SnapZone, Icon: typeof PanelLeft, label: string) => (
    <button
      type="button"
      data-no-drag
      title={label}
      onClick={() => onSnap(zone)}
      className={cn(
        'h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted transition-colors',
        panel.snap === zone && 'bg-muted text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div
      ref={ref}
      style={{ ...computeFloatingPanelStyle(panel, bounds), zIndex }}
      onMouseDown={onFocus}
      className="absolute pointer-events-auto flex flex-col rounded-lg border border-border bg-background shadow-2xl overflow-hidden"
    >
      {/* Title bar — drag handle + dock controls */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center gap-1 px-2 h-8 shrink-0 border-b border-border bg-muted/40 cursor-move select-none"
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium truncate min-w-0 flex-1">{title}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          {snapBtn('left', PanelLeft, 'Dock left')}
          {snapBtn('bottom', PanelBottom, 'Dock bottom')}
          {snapBtn('right', PanelRight, 'Dock right')}
          {snapBtn('free', Square, 'Free float')}
          <button
            type="button"
            data-no-drag
            title="Dock into right panel"
            onClick={onDock}
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted transition-colors"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-no-drag
            title="Close"
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

      {/* Resize affordance */}
      <div
        onMouseDown={onResizeStart}
        className={cn(
          'absolute z-10',
          panel.snap === 'bottom'
            ? 'top-0 inset-x-0 h-1.5 cursor-row-resize'
            : panel.snap === 'left'
              ? 'right-0 inset-y-0 w-1.5 cursor-col-resize'
              : panel.snap === 'right'
                ? 'left-0 inset-y-0 w-1.5 cursor-col-resize'
                : 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
        )}
      />
    </div>
  );
}
