/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Hosted openings must fit both end faces after a wall join (#6232 D5).
 * A wall axis can still span an opening when an oblique body face cuts it. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { WallJoinTarget } from './wall-join-apply.js';
import { wallBodyOutline, type WallJoinWall } from './wall-join.js';
import { readHostOpeningExtents } from './hosted-element.js';

/** Safe longitudinal interval in the ORIGINAL placement frame, in metres.
 * Using both faces deliberately refuses a cut straddling an oblique end. */
export function wallOpeningBodySpan(original: WallJoinTarget, next: WallJoinWall): [number, number] {
  const length = Math.hypot(original.wall.end[0] - original.wall.start[0], original.wall.end[1] - original.wall.start[1]);
  const ux = (original.wall.end[0] - original.wall.start[0]) / length;
  const uy = (original.wall.end[1] - original.wall.start[1]) / length;
  const first = (next.start[0] - original.origin[0]) * ux + (next.start[1] - original.origin[1]) * uy;
  const { corners } = wallBodyOutline(next);
  return [first + Math.max(corners[0][0], corners[3][0]), first + Math.min(corners[1][0], corners[2][0])];
}

export function assertWallOpeningsFit(
  store: IfcDataStore, view: MutablePropertyView, original: WallJoinTarget, next: WallJoinWall, scale: number,
): void {
  const hosted = readHostOpeningExtents(store, original.wallId, view);
  if (hosted.unreadable.length) {
    throw new Error(`Wall #${original.wallId} has unreadable opening geometry ${hosted.unreadable.map(id => `#${id}`).join(', ')}; joining is refused`);
  }
  const [from, to] = wallOpeningBodySpan(original, next);
  // The existing Trim/Extend contract allows 1 mm of modelling roundoff.
  const outside = hosted.cuts.find(({ bounds }) => bounds.min[0] * scale < from - 1e-3 || bounds.max[0] * scale > to + 1e-3);
  if (outside) throw new Error(`Opening #${outside.openingId} would not fit between the joined end faces of wall #${original.wallId}`);
}
