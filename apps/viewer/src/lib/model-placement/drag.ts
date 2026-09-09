/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Translation } from './translation.js';
export interface ScreenVector { x: number; y: number }
export type DragBasis = readonly { axis: 0 | 1 | 2; screen: ScreenVector }[];

/** Project onto an axis, or solve a plane's two projected basis vectors.
 * Reject edge-on handles rather than amplifying a pixel into kilometres. */
export function dragTranslation(basis: DragBasis, cursor: ScreenVector): Translation | null {
  const delta: [number, number, number] = [0, 0, 0];
  if (basis.length === 1) {
    const { axis, screen } = basis[0], squared = screen.x ** 2 + screen.y ** 2;
    if (squared < 1e-6) return null;
    delta[axis] = (cursor.x * screen.x + cursor.y * screen.y) / squared;
  } else if (basis.length === 2) {
    const [a, b] = basis, determinant = a.screen.x * b.screen.y - a.screen.y * b.screen.x;
    const magnitude = Math.hypot(a.screen.x, a.screen.y) * Math.hypot(b.screen.x, b.screen.y);
    if (magnitude < 1e-6 || Math.abs(determinant) / magnitude < 0.05) return null;
    delta[a.axis] = (cursor.x * b.screen.y - cursor.y * b.screen.x) / determinant;
    delta[b.axis] = (a.screen.x * cursor.y - a.screen.y * cursor.x) / determinant;
  } else return null;
  return delta.every(Number.isFinite) ? delta : null;
}
