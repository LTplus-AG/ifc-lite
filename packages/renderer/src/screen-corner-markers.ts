/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap markers of the CAD-style corner search (#11504): the corners near the
 * cursor and the one the pick used, published after each magnetic pick so a
 * host can draw them. The list is the one the snap itself searched
 * (`ScreenCornerIndex.candidatesNear`), never a second computation, so a
 * marker is never offered that the snap would refuse.
 */

import type { Vec3 } from './raycaster.js';
import type { ScreenCornerCandidate, ScreenCornerIndex, ScreenCornerSnapOptions } from './snap-screen-corners.js';

export const DEFAULT_MARKER_RADIUS_PX = 48;
export const DEFAULT_MARKER_LIMIT = 12;
/** A snapped position this close to a candidate (world units) is that candidate. */
const SAME_POINT = 1e-6;

export interface ScreenCornerMarkers {
  /** The view the corners were projected under; a host hides them once the view differs. */
  viewKey: string;
  /** Nearest first. */
  candidates: readonly ScreenCornerCandidate[];
  /** Index into `candidates` of the corner the pick used, or -1 when it used none of them. */
  activeIndex: number;
}

/** Which candidate, if any, is the snapped position of a vertex snap. */
export function activeCornerIndex(candidates: readonly ScreenCornerCandidate[], snapped: { type: string; position: Vec3 } | null | undefined): number {
  if (!snapped || snapped.type !== 'vertex') return -1;
  const p = snapped.position;
  return candidates.findIndex((c) =>
    Math.abs(c.position.x - p.x) <= SAME_POINT && Math.abs(c.position.y - p.y) <= SAME_POINT && Math.abs(c.position.z - p.z) <= SAME_POINT);
}

function same(a: ScreenCornerMarkers | null, b: ScreenCornerMarkers | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.viewKey !== b.viewKey || a.activeIndex !== b.activeIndex || a.candidates.length !== b.candidates.length) return false;
  return a.candidates.every((c, i) => {
    const o = b.candidates[i];
    return c.expressId === o.expressId && c.screen.x === o.screen.x && c.screen.y === o.screen.y
      && c.position.x === o.position.x && c.position.y === o.position.y && c.position.z === o.position.z;
  });
}

/** Holds the latest markers and tells subscribers when they change. */
export class CornerMarkerChannel {
  private current: ScreenCornerMarkers | null = null;
  private listeners = new Set<() => void>();

  get(): ScreenCornerMarkers | null { return this.current; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(next: ScreenCornerMarkers | null): void {
    if (same(this.current, next)) return;
    this.current = next;
    for (const l of [...this.listeners]) l();
  }

  /**
   * Publish the markers of the pick that just ran, when its options ask for them
   * (`markers`). Without that option nothing is touched: a pick that does not
   * draw markers must not clear another tool's.
   */
  publish(
    index: ScreenCornerIndex, config: ScreenCornerSnapOptions | undefined, x: number, y: number, viewKey: string,
    snapped: { type: string; position: Vec3 } | null | undefined,
  ): void {
    if (!config?.markers) return;
    const candidates = index.candidatesNear(x, y, config.markerRadiusPx ?? DEFAULT_MARKER_RADIUS_PX, config.markerLimit ?? DEFAULT_MARKER_LIMIT);
    this.set(candidates.length === 0 ? null : { viewKey, candidates, activeIndex: activeCornerIndex(candidates, snapped) });
  }
}
