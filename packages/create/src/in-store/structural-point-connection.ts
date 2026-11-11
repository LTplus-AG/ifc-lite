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
 *   each a 2-branch SELECT of `IfcBoolean` or a stiffness measure;
 *   `true` = fixed/rigid, `false` = free, a number = spring stiffness.)
 *   IFC2X3 has no `ConditionCoordinateSystem`, and its node condition slots
 *   (`LinearStiffnessX`…) are plain measures, so `true`/`false` are written
 *   as `-1.`/`0.`, the IFC2X3 rigid/free convention.
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

/**
 * `true` = fixed, `false` = free; a number supplies spring stiffness.
 * IFC4+ writes the corresponding boolean or measure branch of
 * `IfcTranslationalStiffnessSelect`/`IfcRotationalStiffnessSelect`; IFC2X3
 * writes plain measures, mapping fixed/free to `-1.`/`0.`.
 */
export interface StructuralBoundaryConditionParams {
  Name?: string;
  TranslationalStiffnessX?: boolean | number;
  TranslationalStiffnessY?: boolean | number;
  TranslationalStiffnessZ?: boolean | number;
  RotationalStiffnessX?: boolean | number;
  RotationalStiffnessY?: boolean | number;
  RotationalStiffnessZ?: boolean | number;
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

/** `IfcBoundaryNodeCondition` stiffness slots, in attribute order. */
const STIFFNESS_KEYS = [
  'TranslationalStiffnessX', 'TranslationalStiffnessY', 'TranslationalStiffnessZ',
  'RotationalStiffnessX', 'RotationalStiffnessY', 'RotationalStiffnessZ',
] as const;
type StiffnessKey = (typeof STIFFNESS_KEYS)[number];

export function addStructuralPointConnectionToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StructuralPointConnectionInStoreParams,
): StructuralPointConnectionBuildResult {
  const is2x3 = anchor.schema === 'IFC2X3';
  // IFC2X3 uses plain measures: -1 = rigid, 0 = free. The `{ real }` marker is
  // required: the exporter's SELECT qualification reads the IFC4 registry for
  // every target schema and would wrap a bare number as an IFC4 select member.
  const stiffness = (key: StiffnessKey, value: boolean | number | undefined) => {
    if (value === undefined) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`addStructuralPointConnectionToStore: ${key} must be a finite spring stiffness`);
    }
    if (!is2x3) return value;
    return { real: typeof value === 'number' ? value : value ? -1 : 0 };
  };
  // Resolved before any entity is emitted, so a refused value leaves the store untouched.
  const bc = params.BoundaryCondition;
  const conditionAttrs = bc ? [bc.Name ?? null, ...STIFFNESS_KEYS.map((key) => stiffness(key, bc[key]))] : undefined;
  const position = toNativePoint3(anchor, params.Position);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, position);
  const boundaryConditionId = conditionAttrs ? editor.addEntity('IfcBoundaryNodeCondition', conditionAttrs).expressId : undefined;

  const connectionId = editor.addEntity('IfcStructuralPointConnection', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Structural Point Connection',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    null, // Representation — see module doc
    boundaryConditionId === undefined ? null : `#${boundaryConditionId}`,
    ...(is2x3 ? [] : [null]), // ConditionCoordinateSystem (IFC4+)
  ]).expressId;

  return { connectionId, placementId, ...(boundaryConditionId !== undefined ? { boundaryConditionId } : {}) };
}
