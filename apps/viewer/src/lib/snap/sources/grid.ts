/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grid snap source: the node of the construction grid drawn at workplane
 * elevation that is nearest the cursor. Profiles put `grid` in their lowest
 * tier, so a node only wins when no geometric target is in range; under a
 * lock the solver projects the node onto it (alignment with the grid).
 */

import { nearestGridNode, type GridSpec } from '../grid.js';
import type { SnapCandidate, SnapQuery, SnapSource } from '../types.js';

/** `spec` returning null (grid hidden) contributes nothing. */
export function createGridSource(spec: GridSpec | (() => GridSpec | null), id = 'grid'): SnapSource {
  const read = typeof spec === 'function' ? spec : () => spec;
  return {
    id,
    collect(q: SnapQuery, _radius: number, out: SnapCandidate[]): void {
      const g = read();
      if (!g) return;
      const node = nearestGridNode(q.cursor, g);
      if (node) out.push({ kind: 'grid', local: node, source: 'grid' });
    },
  };
}
