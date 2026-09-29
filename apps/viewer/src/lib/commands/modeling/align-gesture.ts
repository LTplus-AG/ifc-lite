/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gesture of `element.align` (charter #6232, C4) and the moves it would
 * make, apart from the command so its bar and layers can read them without
 * importing it back.
 */

import { alignShift, type AlignMode, type PlanBox } from './align-boxes.js';

export interface AlignGesture {
  /** The session storey's elements with geometry, in the session workplane. */
  readonly boxes: ReadonlyMap<number, PlanBox>;
  readonly reference: number | null;
  readonly targets: readonly number[];
  readonly mode: AlignMode;
  readonly hover: number | null;
}

/** A shift below this (metres) is already aligned. */
const ALIGNED = 1e-4;


/** The moves the gesture would make: each target's shift, the ones already aligned left out. */
export function alignMoves(g: AlignGesture): { id: number; shift: [number, number] }[] {
  const reference = g.reference === null ? null : g.boxes.get(g.reference);
  if (!reference) return [];
  const moves: { id: number; shift: [number, number] }[] = [];
  for (const id of g.targets) {
    const box = g.boxes.get(id);
    if (!box) continue;
    const [du, dv] = alignShift(g.mode, reference, box);
    if (Math.hypot(du, dv) > ALIGNED) moves.push({ id, shift: [du, dv] });
  }
  return moves;
}

