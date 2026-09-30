/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gesture of `element.pushPull` (charter #6232, C4), apart from the
 * command so its handles, bar and drag can read it without importing it back.
 */

import type { PushPullFace, PushPullTarget } from './push-pull-target';

export interface PushPullGesture {
  readonly target: PushPullTarget | null;
  /** The grabbed face, once one is. */
  readonly faceId: PushPullFace['id'] | null;
  /** The size the face now asks for (metres); null until it moved or one was typed. */
  readonly size: number | null;
  /** A size was typed: the pointer stops steering it. */
  readonly typed: boolean;
  /** What the drag snapped to, for the readout. */
  readonly snapped: 'level' | 'step' | null;
}

export const faceOf = (g: PushPullGesture): PushPullFace | null => g.target?.faces.find((f) => f.id === g.faceId) ?? null;

/** The size the gesture would write: the dragged or typed one, else the face's own. */
export const sizeOf = (g: PushPullGesture): number | null => {
  const face = faceOf(g);
  return face ? g.size ?? face.size : null;
};

