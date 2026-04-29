/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Duplicate an existing IfcRoot product in place via the StoreEditor
 * overlay. Geometry is shared (the new entity points at the source's
 * Representation by reference), and the new placement is offset from
 * the source's so the duplicate is visible — the user can refine the
 * position via Raw STEP editing or, in a future PR, a place-mode
 * cursor flow.
 *
 * What lands in the overlay (4 new entities + 1 new spatial rel):
 *   1. IFCCARTESIANPOINT — the new world position
 *   2. IFCAXIS2PLACEMENT3D — wraps the new point, reuses source axes
 *   3. IFCLOCALPLACEMENT — chains to the source's parent placement
 *   4. {SourceType} — new GUID + new placement, same Representation ref
 *   5. IFCRELCONTAINEDINSPATIALSTRUCTURE — anchors the new entity to
 *      the same storey the source belongs to (or skipped if the
 *      source isn't spatially contained)
 *
 * The function is pure — no I/O, no parser access. It accepts the
 * already-extracted source attributes and does the bookkeeping.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcAttributeValue } from '@ifc-lite/mutations';

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function newGuid(): string {
  const bytes = new Uint8Array(22);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 22; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let result = '';
  for (let i = 0; i < 22; i++) result += GUID_CHARS[bytes[i] % 64];
  return result;
}

/** A 3D vector — STEP-local metres. */
export type Vec3 = [number, number, number];

export interface SourceAttributes {
  /** Source entity type (e.g. `'IFCWALL'`, `'IFCCOLUMN'`). */
  type: string;
  /** Source positional attributes as parsed by EntityExtractor. */
  attributes: IfcAttributeValue[];
  /** Express id of the source's IfcLocalPlacement (positional index 5 on IfcProduct). */
  placementExpressId: number;
  /** Express id of the IfcLocalPlacement that the source's placement is chained to (parent). May be null when the source sits at the spatial root. */
  parentPlacementId: number | null;
  /** The 3-component cartesian point referenced by the source's IfcAxis2Placement3D (Location, attribute index 0). */
  sourceLocation: Vec3;
  /** Express id of the source's Representation (positional index 6 on IfcProduct). May be null. */
  representationId: number | null;
  /** OwnerHistory expressId from the source (positional index 1 on IfcRoot). */
  ownerHistoryId: number;
  /** The IfcAxis2Placement3D's `Axis` ref (index 1) verbatim — `"#N"` string or `"$"`. Reused on the new placement so the duplicate keeps source rotation. */
  axisRef: string;
  /** The IfcAxis2Placement3D's `RefDirection` ref (index 2) verbatim. */
  refDirectionRef: string;
  /** Express id of the IfcBuildingStorey containing the source — emit a fresh IfcRelContainedInSpatialStructure pointing at it. Null skips the rel. */
  storeyId: number | null;
}

export interface DuplicateInStoreOptions {
  /** Translation applied to the source's location, in metres. Defaults to `[1, 0, 0]`. */
  offset?: Vec3;
  /** Optional override for the duplicate's Name attribute. Defaults to source.Name + ' (copy)'. */
  name?: string;
}

export interface DuplicateBuildResult {
  /** The new entity's expressId. */
  newId: number;
  newPlacementId: number;
  newPointId: number;
  newAxisPlacementId: number;
  /** The IfcRelContainedInSpatialStructure linking the new entity to its storey. Null when the source had no spatial container. */
  relContainedId: number | null;
}

/**
 * Emit a duplicate of the source product into the editor overlay.
 * Returns the new expressIds. Throws if the source attributes don't
 * have at least 7 slots (the minimum IfcProduct surface).
 */
export function duplicateInStore(
  editor: StoreEditor,
  source: SourceAttributes,
  options: DuplicateInStoreOptions = {},
): DuplicateBuildResult {
  if (source.attributes.length < 7) {
    throw new Error(
      `duplicateInStore: source has ${source.attributes.length} attributes, need ≥7 for an IfcProduct`,
    );
  }

  const offset: Vec3 = options.offset ?? [1, 0, 0];
  const newLocation: Vec3 = [
    source.sourceLocation[0] + offset[0],
    source.sourceLocation[1] + offset[1],
    source.sourceLocation[2] + offset[2],
  ];

  // 1. New IfcCartesianPoint at the offset position.
  const point = editor.addEntity('IFCCARTESIANPOINT', [
    [newLocation[0], newLocation[1], newLocation[2]],
  ]);

  // 2. New IfcAxis2Placement3D wrapping the new point. Reuse source
  //    axis + ref-direction so the duplicate keeps the source's
  //    rotation. The two ref args are passed through as the verbatim
  //    STEP tokens captured at extraction time (`"#N"` or `"$"`).
  const axisPlacement = editor.addEntity('IFCAXIS2PLACEMENT3D', [
    `#${point.expressId}`,
    source.axisRef,
    source.refDirectionRef,
  ]);

  // 3. New IfcLocalPlacement chained to the source's parent (or `$`
  //    if the source sat at the spatial root).
  const placement = editor.addEntity('IFCLOCALPLACEMENT', [
    source.parentPlacementId !== null ? `#${source.parentPlacementId}` : null,
    `#${axisPlacement.expressId}`,
  ]);

  // 4. The duplicate IfcRoot. New GUID; new ObjectPlacement; same
  //    Representation reference (geometry shared); name suffix unless
  //    the caller provided one.
  const sourceName = source.attributes[2];
  const duplicateName: IfcAttributeValue = options.name !== undefined
    ? options.name
    : (typeof sourceName === 'string' && sourceName.length > 0
        ? `${sourceName} (copy)`
        : sourceName);

  const cloned = source.attributes.slice();
  cloned[0] = newGuid();                        // GlobalId
  cloned[1] = `#${source.ownerHistoryId}`;       // OwnerHistory (preserved)
  cloned[2] = duplicateName;                    // Name
  cloned[5] = `#${placement.expressId}`;         // ObjectPlacement
  // cloned[6] (Representation) intentionally untouched — share geometry.
  // cloned[7] (Tag) — leave the source tag; STEP allows duplicate tags.

  const duplicate = editor.addEntity(source.type, cloned);

  // 5. Optional: new IfcRelContainedInSpatialStructure anchoring the
  //    new entity to the same storey. Skipped when the source had no
  //    storey context.
  let relContainedId: number | null = null;
  if (source.storeyId !== null) {
    const rel = editor.addEntity('IFCRELCONTAINEDINSPATIALSTRUCTURE', [
      newGuid(),                          // GlobalId
      `#${source.ownerHistoryId}`,         // OwnerHistory
      null,                                // Name
      null,                                // Description
      [`#${duplicate.expressId}`],         // RelatedElements
      `#${source.storeyId}`,               // RelatingStructure
    ]);
    relContainedId = rel.expressId;
  }

  return {
    newId: duplicate.expressId,
    newPlacementId: placement.expressId,
    newPointId: point.expressId,
    newAxisPlacementId: axisPlacement.expressId,
    relContainedId,
  };
}
