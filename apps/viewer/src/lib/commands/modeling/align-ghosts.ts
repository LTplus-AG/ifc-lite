/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { alignMoves, shiftBox } from '@ifc-lite/create';
import type { Workplane } from './types';
import type { AlignGesture } from './align-gesture';
import { prismGhostMesh, rectOutline } from './ghost-shapes';
/** The native Align preview is explicitly a bounds prism, not a solid mesh. */
export function alignmentGhosts(g: AlignGesture, plane: Workplane, base: number) {
  return alignMoves(g).flatMap(({ id, shift }, i) => {
    const box = g.boxes.get(id);
    if (!box) return [];
    const moved = shiftBox(box, shift);
    const mesh = prismGhostMesh(plane, rectOutline(moved.min, moved.max), moved.z0, moved.z1, base + i);
    return mesh ? [mesh] : [];
  });
}
