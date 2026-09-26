/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure placement geometry for floating / edge-snapped workspace panels
 * (#1201 / #1245). Kept DOM- and React-free (type-only imports) so the
 * regression-critical snapping math can be unit-tested without a renderer.
 */

import type { CSSProperties } from 'react';
import type { FloatingPanelState } from '@/store';

/**
 * The region an edge-snapped panel docks into, in window coordinates. Snapping
 * to this region (the 3D viewport) rather than the whole window keeps the
 * toolbar, hierarchy, sidebar and status bar visible — and, crucially, keeps a
 * docked panel's own title bar (close / un-dock controls) out from under the
 * z-50 toolbar so it can always be closed (#1245).
 */
export interface SnapBounds {
  /** px from the window's top / left edge to the region's top / left edge. */
  top: number;
  left: number;
  /** px from the window's right / bottom edge to the region's edge (CSS right/bottom). */
  right: number;
  bottom: number;
  /** Region extent, used to clamp a snapped panel so it can't outgrow the region. */
  width: number;
  height: number;
}

/** The area free-floating panels are positioned in (the window). */
export interface FloatingArea {
  width: number;
  height: number;
  /**
   * px from the window top that a free panel's top edge may not rise above:
   * the bottom of the z-50 toolbar (the viewport region's top). A panel at
   * `top: 0` would hide its whole title bar (drag handle, dock, close) under
   * the toolbar, with no way to grab it back (#5957, the #1245 class).
   */
  top: number;
}

/**
 * Absolute-position style for a floating panel.
 *
 * - `free` panels sit at their stored window coordinates, clamped into `area`
 *   when it is known (#5854), never above the toolbar bottom `area.top`
 *   (#5957): a position saved on a bigger screen, or before
 *   the window shrank, would otherwise leave the panel (and its close button)
 *   off screen for good. Only the drawn rect is clamped; the stored position
 *   is left alone until the user drags, so growing the window back restores
 *   the panel where they put it.
 * - Edge snaps (`left` / `right` / `bottom`) confine to `bounds` — the viewport
 *   region — so a docked panel never hides under the toolbar (its own close
 *   control with it) or over the hierarchy / sidebar, and can't outgrow the
 *   region. When `bounds` is null (not yet measured — at most one frame, since
 *   the host measures in a layout effect) snaps fall back to the window edges.
 */
export function computeFloatingPanelStyle(
  p: FloatingPanelState,
  bounds: SnapBounds | null,
  area: FloatingArea | null = null,
): CSSProperties {
  if (p.snap === 'free') {
    if (!area) return { left: p.x, top: p.y, width: p.w, height: p.h };
    const width = Math.min(p.w, area.width);
    const height = Math.min(p.h, Math.max(0, area.height - area.top));
    return {
      left: Math.min(Math.max(0, p.x), area.width - width),
      top: Math.min(Math.max(area.top, p.y), area.height - height),
      width,
      height,
    };
  }

  const top = bounds?.top ?? 0;
  const left = bounds?.left ?? 0;
  const right = bounds?.right ?? 0;
  const bottom = bounds?.bottom ?? 0;
  const width = bounds ? Math.min(p.w, bounds.width) : p.w;
  const height = bounds ? Math.min(p.h, bounds.height) : p.h;

  if (p.snap === 'left') return { left, top, bottom, width };
  if (p.snap === 'bottom') return { left, right, bottom, height };
  return { right, top, bottom, width }; // 'right'
}
