/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A storey's placement elevation, the way the IFC path reads it: the STEP builder's `extractPlacementElevation`
 * takes the Z of the storey's own `RelativePlacement`, parent-relative, and does not chain its parents. IFCX places
 * a node with a row-major `usd::xformop` (point * local * parent), whose translation row is that same local offset.
 */

import { ATTR, type ComposedNode } from './types.js';

/**
 * The Z of a node's own transform: 0 when it carries none (an unplaced USD prim sits at its parent's origin), and
 * `undefined` when the transform is corrupt, so a broken placement reads as unknown rather than as a plausible 0.
 */
export function localZ(node: ComposedNode): number | undefined {
  const rows = (node.attributes.get(ATTR.TRANSFORM) as { transform?: number[][] } | undefined)?.transform;
  if (!rows) return 0;
  const z = rows[3]?.[2] ?? 0;
  return typeof z === 'number' && Number.isFinite(z) ? z : undefined;
}
