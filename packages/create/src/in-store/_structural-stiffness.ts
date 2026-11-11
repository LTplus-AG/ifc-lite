/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SpatialAnchor } from './anchor.js';

/** IFC2X3 rigid/free measures; IFC4+ explicitly qualified SELECT members. */
export function structuralStiffness(anchor: SpatialAnchor, value: boolean | number | undefined, measure: string) {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Structural stiffness must be finite');
  return anchor.schema === 'IFC2X3'
    ? { real: typeof value === 'boolean' ? (value ? -1 : 0) : value }
    : { typed: { type: typeof value === 'boolean' ? 'IfcBoolean' : measure, value } };
}

export function assertStructuralBuilderSchema(anchor: SpatialAnchor) {
  if (anchor.schema === 'IFC5') throw new Error('Structural builders: IFC5 is not supported; use IFC2X3, IFC4 or IFC4X3');
}
