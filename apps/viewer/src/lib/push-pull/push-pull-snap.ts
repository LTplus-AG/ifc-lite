/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snapping a push / pull size (charter #6232, C4).
 *
 * The 2D solver (`lib/snap`) works in workplane-local plan coordinates, and a
 * face dragged along its own normal, which is usually vertical, has no plan
 * position to solve. What the drag moves is one number, the dimension, so it
 * snaps in one dimension: to the storeys' floor levels when the face moves
 * vertically (a wall pulled to the storey above), else to a step. The same
 * Snap toggle (S) that the command bars honour turns it off, and Alt holds it
 * off for one drag like the other commands.
 */

import type { ViewerState } from '@/store';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import type { PushPullFace, PushPullTarget } from './push-pull-target';

/** The size step of a snapped drag, and the finer one with Shift (metres). */
export const SNAP_STEP = 0.05;
export const SNAP_STEP_FINE = 0.01;
/** How close a size must come to a level to be pulled onto it (metres). */
const LEVEL_REACH = 0.12;
/** The smallest size a drag can reach. */
export const MIN_SIZE = 0.01;

export interface SizeSnap {
  readonly size: number;
  readonly kind: 'level' | 'step' | null;
}

export interface SnapOptions {
  readonly enabled: boolean;
  readonly fine: boolean;
  /** Face heights (storey-local metres) worth landing on: the other storeys' floors. */
  readonly levels: readonly number[];
}

/** The other storeys' floors relative to the element's own storey, storey-local metres. */
export function levelHeights(s: ViewerState, target: PushPullTarget): number[] {
  const storeys = modelStoreys(s, target.modelId);
  const own = storeys.find((storey) => storey.expressId === target.storeyId);
  return own ? storeys.filter((storey) => storey !== own).map((storey) => storey.elevation - own.elevation) : [];
}

/** `raw` (the dimension the pointer asks for), snapped, and never below the minimum. */
export function snapSize(face: PushPullFace, raw: number, options: SnapOptions): SizeSnap {
  const size = Math.max(MIN_SIZE, raw);
  if (!options.enabled) return { size, kind: null };
  // A vertical face lands its plane on a level: size = current + (level - face height) along the normal.
  if (Math.abs(face.normal[2]) > 0.999 && face.gain === 1) {
    let best: number | null = null;
    for (const level of options.levels) {
      const candidate = face.size + (level - face.origin[2]) * face.normal[2];
      if (candidate >= MIN_SIZE && Math.abs(candidate - size) <= LEVEL_REACH && (best === null || Math.abs(candidate - size) < Math.abs(best - size))) best = candidate;
    }
    if (best !== null) return { size: best, kind: 'level' };
  }
  const step = options.fine ? SNAP_STEP_FINE : SNAP_STEP;
  return { size: Math.max(MIN_SIZE, Math.round(size / step) * step), kind: 'step' };
}
