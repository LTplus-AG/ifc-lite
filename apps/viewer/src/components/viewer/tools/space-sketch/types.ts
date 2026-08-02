/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared UI types for the Space Sketch overlay and its sub-components. */

import type { Pt } from '@/lib/space-sketch-geometry';

/** What the cursor is currently over (drives the hover highlight). */
export type Hover =
  | { kind: 'vertex'; pos: Pt }
  | { kind: 'edge'; edge: number; rooms: number[]; a: Pt; b: Pt }
  | null;

/** A split endpoint the user picked — an existing corner, or a point on a wall
 *  edge (which becomes a new node when the cut is committed). */
export type SplitTarget =
  | { kind: 'vertex'; vid: number; pos: Pt }
  | { kind: 'edge'; edge: number; pos: Pt };

/** The colour language for the live action-intent chip + on-canvas cues:
 *  green = create/draw, blue = cut/split, red = remove/merge, neutral = move/pan. */
export type IntentTone = 'move' | 'draw' | 'cut' | 'remove' | 'pan';

export interface Intent { text: string; tone: IntentTone }
