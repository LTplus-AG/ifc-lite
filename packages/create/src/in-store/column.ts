/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcColumn — emits the full sub-graph (placement,
 * profile, extruded solid, representation, product shape, column,
 * IfcRelContainedInSpatialStructure) into a `StoreEditor`'s overlay.
 *
 * The column lands in the spatial structure of an existing parsed model
 * (anchored to a storey + the model's owner history + its 'Body'
 * representation context). This is the in-place equivalent of
 * `IfcCreator.addIfcColumn()` and closes the merge-roundtrip gap from
 * louistrue/ifc-lite#592.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';

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

export interface ColumnInStoreParams {
  /** Base centre of the column, in storey-local coordinates (metres). */
  Position: [number, number, number];
  /** Profile width along storey-local X (metres). */
  Width: number;
  /** Profile depth along storey-local Y (metres). */
  Depth: number;
  /** Extrusion height along +Z (metres). */
  Height: number;
  /** IfcRoot Name attribute (default `'Column'`). */
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

/**
 * Result of `addColumnToStore` — the new column's expressId plus a
 * tap into the dependent entities for callers that want to e.g. apply
 * a colour or further mutations to the geometry.
 */
export interface ColumnBuildResult {
  columnId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  /** The IfcRelContainedInSpatialStructure linking the column to its storey. */
  relContainedId: number;
}

/**
 * Add an IfcColumn to a parsed model via the StoreEditor overlay. Returns
 * the freshly-allocated expressIds for every entity that was emitted.
 *
 * The caller is responsible for resolving `anchor` from the parsed store
 * (look up IfcOwnerHistory, the 'Body' representation context, and the
 * target IfcBuildingStorey + its ObjectPlacement).
 */
export function addColumnToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: ColumnInStoreParams,
): ColumnBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;

  // Local placement chain: IfcCartesianPoint → IfcAxis2Placement3D →
  // IfcLocalPlacement (parent = storey placement).
  const colOriginPt = editor.addEntity('IFCCARTESIANPOINT', [params.Position]).expressId;
  const colAxis = editor.addEntity('IFCAXIS2PLACEMENT3D', [`#${colOriginPt}`, null, null]).expressId;
  const placementId = editor.addEntity('IFCLOCALPLACEMENT', [
    `#${storeyPlacementId}`,
    `#${colAxis}`,
  ]).expressId;

  // Rectangle profile centred at origin: IfcCartesianPoint(0,0) →
  // IfcAxis2Placement2D → IfcRectangleProfileDef.
  const profileOriginPt = editor.addEntity('IFCCARTESIANPOINT', [[0, 0]]).expressId;
  const profilePos = editor.addEntity('IFCAXIS2PLACEMENT2D', [`#${profileOriginPt}`, null]).expressId;
  const profileId = editor.addEntity('IFCRECTANGLEPROFILEDEF', [
    '.AREA.',
    null,
    `#${profilePos}`,
    params.Width,
    params.Depth,
  ]).expressId;

  // Extruded solid: another local origin point, axis placement, +Z direction,
  // then IfcExtrudedAreaSolid(Profile, Position, ExtrudedDirection, Depth).
  const solidOriginPt = editor.addEntity('IFCCARTESIANPOINT', [[0, 0, 0]]).expressId;
  const solidAxis = editor.addEntity('IFCAXIS2PLACEMENT3D', [`#${solidOriginPt}`, null, null]).expressId;
  const extrudeDirection = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]).expressId;
  const solidId = editor.addEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    `#${solidAxis}`,
    `#${extrudeDirection}`,
    params.Height,
  ]).expressId;

  // Shape representation in the Body context, then product shape.
  const shapeRepId = editor.addEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContextId}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IFCPRODUCTDEFINITIONSHAPE', [
    null,
    null,
    [`#${shapeRepId}`],
  ]).expressId;

  // The column itself.
  const columnId = editor.addEntity('IFCCOLUMN', [
    newGuid(),
    `#${ownerHistoryId}`,
    params.Name ?? 'Column',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
    '.COLUMN.',
  ]).expressId;

  // Link column → storey via a fresh IfcRelContainedInSpatialStructure.
  // Adding a parallel relationship is simpler than mutating the storey's
  // existing one and produces an equivalent result on import.
  const relContainedId = editor.addEntity('IFCRELCONTAINEDINSPATIALSTRUCTURE', [
    newGuid(),
    `#${ownerHistoryId}`,
    null,
    null,
    [`#${columnId}`],
    `#${storeyId}`,
  ]).expressId;

  return {
    columnId,
    placementId,
    profileId,
    solidId,
    shapeRepId,
    productShapeId,
    relContainedId,
  };
}
