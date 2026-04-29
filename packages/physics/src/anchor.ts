/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, AnchorReason } from './types.js';

const GROUND_CONTACT_TYPES = new Set(['IfcSlab', 'IfcFooting', 'IfcPile', 'IfcFoundation']);

export interface AnchorContext {
  modelFloor: number;
  groundTolerance: number;
  explicitAnchors: Set<number>;
  anchorTypes: Set<string>;
}

/**
 * Returns the reason this entity is anchored, or null if it should be dynamic.
 *
 * Rules (mirrors the Rust crate):
 * 1. Caller-supplied `anchor` list always wins.
 * 2. IFC types in `anchor_ifc_types` are anchored regardless of position.
 * 3. Slabs / footings whose underside touches the model floor are anchored.
 */
export function classifyAnchor(
  expressId: number,
  ifcType: string,
  aabb: AABB,
  ctx: AnchorContext,
): AnchorReason | null {
  if (ctx.explicitAnchors.has(expressId)) return 'explicit';
  if (ctx.anchorTypes.has(ifcType)) return 'ifcType';
  const touchesGround = Math.abs(aabb.min[2] - ctx.modelFloor) <= ctx.groundTolerance;
  if (touchesGround && GROUND_CONTACT_TYPES.has(ifcType)) return 'ifcType';
  return null;
}

/** Crude per-IFC-type density in kg/m³. */
export function densityFor(ifcType: string): number {
  switch (ifcType) {
    case 'IfcSlab':
    case 'IfcWall':
    case 'IfcWallStandardCase':
    case 'IfcColumn':
    case 'IfcBeam':
    case 'IfcFooting':
    case 'IfcPile':
    case 'IfcFoundation':
    case 'IfcStair':
    case 'IfcRamp':
    case 'IfcRoof':
      return 2400;
    case 'IfcMember':
    case 'IfcPlate':
      return 7850;
    case 'IfcWindow':
    case 'IfcDoor':
    case 'IfcRailing':
      return 700;
    case 'IfcCovering':
      return 1500;
    default:
      return 1500;
  }
}
