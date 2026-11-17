/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The state a reviewed storey plan depends on, as one short hash (#9013).
 *
 * A plan keeps ids and offsets; the records behind them can still change
 * after review: a product renamed or retyped, a placement point moved, an
 * axis rotated. The fingerprint covers each product's own record and its
 * whole placement chain (local placements up to the root, their axis
 * placements, points and directions), read through the live overlay, so any
 * such edit changes it and the apply refuses the plan as stale.
 *
 * A grid placement is followed through its intersection, axes and axis
 * curves to the grid's own placement, so moving a grid after review is seen
 * by every product bound to it.
 */

import type { AnchorEntityReader } from '../resolve-anchor.js';
import { refId } from '../host-geometry-frame.js';
import { gridPlacementParent } from './storey-grid.js';

type Reader = Pick<AnchorEntityReader, 'entity'>;
type Referencers = (id: number) => readonly number[];

function references(attributes: readonly unknown[]): number[] {
  return attributes.flatMap((value) => (Array.isArray(value) ? value : [value]).map(refId)).filter((id): id is number => id !== null);
}

/**
 * Records of the placement graph above `placementId`, into `out`: every
 * record a placement refers to (parents, axes, points, directions; grid
 * intersections, axes and their curves), and a grid placement's grid placement.
 */
function collectPlacement(reader: Reader, referencers: Referencers, placementId: number, out: Map<number, string>): void {
  const queue = [placementId];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    const entity = reader.entity(id);
    out.set(id, entity ? `${entity.type.toUpperCase()}${JSON.stringify(entity.attributes)}` : 'missing');
    if (!entity) continue;
    queue.push(...references(entity.attributes));
    if (entity.type.toUpperCase() === 'IFCGRIDPLACEMENT') {
      const grid = gridPlacementParent(reader, referencers, id);
      if (grid !== null) queue.push(grid);
    }
  }
}

/** cyrb53: a 53-bit string hash, ample for telling one reviewed state from the next. */
function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Fingerprint of `products` (their records and placement chains), of the
 * extra `placements` (chains only) and of plain `others` (their own records:
 * a destination storey, a relationship), read through `reader`;
 * `referencers` resolves a grid placement's grid.
 */
export function storeyStateFingerprint(
  reader: Reader, referencers: Referencers, products: Iterable<number>, placements: Iterable<number> = [], others: Iterable<number> = [],
): string {
  const records = new Map<number, string>();
  for (const id of others) {
    const entity = reader.entity(id);
    records.set(id, entity ? `${entity.type.toUpperCase()}${JSON.stringify(entity.attributes)}` : 'missing');
  }
  for (const product of products) {
    const entity = reader.entity(product);
    records.set(product, entity ? `${entity.type.toUpperCase()}${JSON.stringify(entity.attributes)}` : 'missing');
    const placement = entity ? refId(entity.attributes[5]) : null;
    if (placement !== null) collectPlacement(reader, referencers, placement, records);
  }
  for (const placement of placements) collectPlacement(reader, referencers, placement, records);
  const text = [...records].sort(([a], [b]) => a - b).map(([id, record]) => `${id}:${record}`).join('\n');
  return hash(text);
}
