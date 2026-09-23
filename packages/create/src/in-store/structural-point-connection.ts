/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for `IfcStructuralPointConnection` — a support/joint
 * node at a single point, optionally carrying an `IfcBoundaryNodeCondition`
 * (#5167 task S.1).
 *
 * Schema targeted: IFC4 (IFC4_ADD2_TC1.exp), verified against the generated
 * IFC4 registry's `allAttributes`:
 *   `IfcStructuralPointConnection`: `GlobalId, OwnerHistory?, Name?,
 *    Description?, ObjectType?, ObjectPlacement?, Representation?,
 *    AppliedCondition?, ConditionCoordinateSystem?`
 *   `IfcBoundaryNodeCondition`: `Name?, TranslationalStiffnessX?,
 *    TranslationalStiffnessY?, TranslationalStiffnessZ?,
 *    RotationalStiffnessX?, RotationalStiffnessY?, RotationalStiffnessZ?`
 *   (`IfcTranslationalStiffnessSelect`/`IfcRotationalStiffnessSelect` are
 *   each a 2-branch SELECT of `IfcBoolean` or a stiffness measure; this
 *   builder only writes the `IfcBoolean` branch — `true` = fixed/rigid,
 *   `false` = free — a numeric spring-stiffness value is out of scope here.)
 *
 * REPRESENTATION OWNERSHIP:
 *
 *   `ObjectPlacement`: an `IfcLocalPlacement` at `Position`, chained from
 *   the storey placement (same prologue every other in-store builder in
 *   this directory uses). OWNED exclusively by this connection.
 *
 *   `Representation`: deliberately omitted (`null`). A point's location is
 *   already fully captured by `ObjectPlacement.Location` — adding an
 *   `IfcTopologyRepresentation` with a single `IfcVertexPoint` (as
 *   `structural-curve-member.ts` does for its edge) would duplicate that
 *   same coordinate a second way with no read-side consumer
 *   (`StructuralConnectionInfo` carries no geometry field), so it is not
 *   authored. This is the deliberate asymmetry with the curve member's
 *   representation, not an oversight.
 *
 *   `AppliedCondition` → `IfcBoundaryNodeCondition`, when `BoundaryCondition`
 *   is supplied: a fresh entity per connection, OWNED exclusively — never
 *   shared across connections even when two connections specify identical
 *   stiffness values, so (as with the curve member) removal never has to
 *   reason about a second referrer.
 *
 *   Removal: same known gap as `structural-curve-member.ts` — see that
 *   module's doc comment for the full explanation. `StructuralPointConnectionBuildResult`
 *   exposes every owned id for the same reason.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef, productGuid } from './_emit-helpers.js';

/** The `IfcBoolean` branch of `IfcTranslationalStiffnessSelect`/`IfcRotationalStiffnessSelect`: `true` = fixed, `false` = free. */
export interface StructuralBoundaryConditionParams {
  Name?: string;
  TranslationalStiffnessX?: boolean;
  TranslationalStiffnessY?: boolean;
  TranslationalStiffnessZ?: boolean;
  RotationalStiffnessX?: boolean;
  RotationalStiffnessY?: boolean;
  RotationalStiffnessZ?: boolean;
}

export interface StructuralPointConnectionInStoreParams {
  Position: [number, number, number];
  Name?: string;
  Description?: string;
  ObjectType?: string;
  /** Emits an `IfcBoundaryNodeCondition` referenced by `AppliedCondition`. */
  BoundaryCondition?: StructuralBoundaryConditionParams;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

/** Every expressId this builder emits — the connection's full owned sub-graph. */
export interface StructuralPointConnectionBuildResult {
  connectionId: number;
  placementId: number;
  boundaryConditionId?: number;
}

function boolAttr(v: boolean | undefined): '.T.' | '.F.' | null {
  return v === undefined ? null : v ? '.T.' : '.F.';
}

export function addStructuralPointConnectionToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StructuralPointConnectionInStoreParams,
): StructuralPointConnectionBuildResult {
  if ((anchor.schema ?? 'IFC4') === 'IFC2X3') {
    throw new Error('addStructuralPointConnectionToStore: IFC2X3 has no IfcStructuralPointConnection — target IFC4 or later');
  }
  const position = toNativePoint3(anchor, params.Position);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, position);

  let boundaryConditionId: number | undefined;
  const bc = params.BoundaryCondition;
  if (bc) {
    boundaryConditionId = editor.addEntity('IfcBoundaryNodeCondition', [
      bc.Name ?? null,
      boolAttr(bc.TranslationalStiffnessX),
      boolAttr(bc.TranslationalStiffnessY),
      boolAttr(bc.TranslationalStiffnessZ),
      boolAttr(bc.RotationalStiffnessX),
      boolAttr(bc.RotationalStiffnessY),
      boolAttr(bc.RotationalStiffnessZ),
    ]).expressId;
  }

  const connectionId = editor.addEntity('IfcStructuralPointConnection', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Structural Point Connection',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    null, // Representation — see module doc
    boundaryConditionId === undefined ? null : `#${boundaryConditionId}`,
    null, // ConditionCoordinateSystem
  ]).expressId;

  return { connectionId, placementId, ...(boundaryConditionId !== undefined ? { boundaryConditionId } : {}) };
}
