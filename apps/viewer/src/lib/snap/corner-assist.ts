/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's side of CAD-style corner snapping (#11504): which picks run the
 * screen-space corner search with markers, when X-ray applies, and what the
 * marker overlay draws. Pure functions over plain state, so the rules the
 * three pickers (Measure, a modeling command, Reposition) and the viewport
 * share are tested without a renderer.
 */

import type { ScreenCornerMarkers, ScreenCornerSnapOptions } from '@ifc-lite/renderer';

/** The tool and picking state the rules read. */
export interface SnapPickState {
  activeTool: string;
  repositionPicking: boolean;
  snapEnabled: boolean;
  snapXray: boolean;
}

/**
 * A point is being picked with snapping: the Measure tool, a modeling command
 * (both run as the active tool) or an armed Reposition pick. The marker
 * overlay draws only then, and only with snapping on.
 */
export function isSnapPicking(s: Pick<SnapPickState, 'activeTool' | 'repositionPicking'>): boolean {
  return s.activeTool === 'measure' || s.activeTool === 'command' || s.repositionPicking;
}

/**
 * X-ray applies while Measure or a Reposition pick runs. A modeling command
 * is not offered the toggle, so a preference set earlier does not reach it.
 */
export function isSnapXrayActive(s: Pick<SnapPickState, 'activeTool' | 'repositionPicking' | 'snapXray'>): boolean {
  return s.snapXray && (s.activeTool === 'measure' || s.repositionPicking);
}

/**
 * The `screenCornerSnap` option of a pick: markers on, and with X-ray the
 * occlusion rule off, so corners behind other geometry can be snapped.
 */
export function screenCornerSnapConfig(xray: boolean): ScreenCornerSnapOptions {
  return xray ? { markers: true, ignoreOcclusion: true } : { markers: true };
}

/** One shared empty set: X-ray ghosts every entity by naming none of them as the exception. */
const GHOST_EVERYTHING: Set<number> = new Set();

/**
 * The `ghostExceptEntities` the renderer is given. With X-ray active every
 * entity renders translucent (selected ones stay solid, per the renderer);
 * otherwise the store's own channel, untouched, so leaving X-ray restores the
 * appearance exactly, whatever other feature owns the ghosting.
 */
export function effectiveGhostExcept(xrayActive: boolean, stored: Set<number> | null): Set<number> | null {
  return xrayActive ? GHOST_EVERYTHING : stored;
}

/** A marker as the overlay draws it. */
export interface CornerMarkerView {
  key: string;
  x: number;
  y: number;
  /** The corner the pick will use. */
  active: boolean;
}

/**
 * The markers to draw: none once the view differs from the one they were
 * projected under (the camera moved), none with no candidates; the active one
 * last so it is drawn on top.
 */
export function cornerMarkerViews(markers: ScreenCornerMarkers | null, currentViewKey: string | null): CornerMarkerView[] {
  if (!markers || currentViewKey === null || markers.viewKey !== currentViewKey) return [];
  const views = markers.candidates.map((c, i) => ({
    key: `${i}:${c.expressId}`, x: c.screen.x, y: c.screen.y, active: i === markers.activeIndex,
  }));
  return [...views.filter((v) => !v.active), ...views.filter((v) => v.active)];
}
