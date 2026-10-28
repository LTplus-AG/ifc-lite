/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A node's placement, the way the IFC path reads it: a storey with no `Elevation` takes the Z of its placement
 * through every parent (the STEP builder's `extractPlacementElevation`). IFCX places a node with a row-major
 * `usd::xformop` (point * local * parent), so the world matrix is the product down the spatial chain and its
 * translation row is where the node sits.
 */

import { ATTR, type ComposedNode } from './types.js';

/** Row-major 4x4: identity when the node carries no transform, NaN entries where its transform is corrupt. */
export type Matrix4 = readonly number[];

export const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node: ComposedNode): Matrix4 {
  const rows = (node.attributes.get(ATTR.TRANSFORM) as { transform?: number[][] } | undefined)?.transform;
  if (!rows) return IDENTITY;
  const out: number[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push(rows[r]?.[c] ?? (r === c ? 1 : 0));
  // A corrupt transform is not the identity: let it poison the chain, so a storey under it reads no placed
  // elevation (the caller's `Number.isFinite` check) rather than a plausible 0 at the origin.
  return out.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN));
}

/** The world matrix of `node` under a parent whose world matrix is `parent`. */
export function worldMatrix(node: ComposedNode, parent: Matrix4): Matrix4 {
  const local = localMatrix(node);
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] += local[r * 4 + k] * parent[k * 4 + c];
  return out;
}

/** The Z of a world matrix's translation row. */
export const worldZ = (m: Matrix4): number => m[14];
