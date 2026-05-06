/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared sub-graph emitters for the in-store element builders.
 *
 * Every IFC element that lands on a storey shares the same prologue
 * (IfcCartesianPoint → IfcAxis2Placement3D → IfcLocalPlacement) and
 * the same epilogue (IfcShapeRepresentation → IfcProductDefinitionShape
 * → IfcRelContainedInSpatialStructure). Extracting those into pure
 * helpers keeps each builder focused on the one part that's actually
 * unique — the profile + element-line attribute order.
 *
 * All helpers operate purely through the StoreEditor; no parser
 * access, no I/O.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';

const POINT_EPSILON = 1e-6;

/**
 * Emit an IfcLocalPlacement chained to a parent. Wraps the cartesian
 * point + axis-placement bookkeeping. Pass `Axis` and/or `RefDirection`
 * as `[x, y, z]` to override defaults (otherwise IFC fills them with
 * world up / world X).
 */
export function emitLocalPlacement(
  editor: StoreEditor,
  parentPlacementId: number,
  location: [number, number, number],
  axis?: [number, number, number],
  refDirection?: [number, number, number],
): number {
  const originPt = editor.addEntity('IfcCartesianPoint', [location]).expressId;
  const axisRef = axis !== undefined
    ? `#${editor.addEntity('IfcDirection', [axis]).expressId}`
    : null;
  const refDirRef = refDirection !== undefined
    ? `#${editor.addEntity('IfcDirection', [refDirection]).expressId}`
    : null;
  const axisPlacement = editor.addEntity('IfcAxis2Placement3D', [
    `#${originPt}`,
    axisRef,
    refDirRef,
  ]).expressId;
  return editor.addEntity('IfcLocalPlacement', [
    `#${parentPlacementId}`,
    `#${axisPlacement}`,
  ]).expressId;
}

/**
 * Emit a centred rectangle profile. `centerX`/`centerY` shift the
 * profile's local origin — useful for slab-style "spans 0..W × 0..D"
 * placements where the centre sits at (W/2, D/2).
 */
export function emitRectangleProfile(
  editor: StoreEditor,
  width: number,
  depth: number,
  centerX = 0,
  centerY = 0,
): number {
  const originPt = editor.addEntity('IfcCartesianPoint', [[centerX, centerY]]).expressId;
  const pos = editor.addEntity('IfcAxis2Placement2D', [`#${originPt}`, null]).expressId;
  return editor.addEntity('IfcRectangleProfileDef', [
    '.AREA.',
    null,
    `#${pos}`,
    width,
    depth,
  ]).expressId;
}

/**
 * Emit an arbitrary closed profile from a 2D polyline. Auto-closes if
 * the input doesn't already terminate at the start point.
 */
export function emitPolygonProfile(
  editor: StoreEditor,
  curve: ReadonlyArray<readonly [number, number]>,
): number {
  if (curve.length < 3) {
    throw new Error('emitPolygonProfile: outline needs at least 3 points');
  }
  const first = curve[0];
  const last = curve[curve.length - 1];
  const closed =
    Math.abs(first[0] - last[0]) < POINT_EPSILON &&
    Math.abs(first[1] - last[1]) < POINT_EPSILON;
  const sequence = closed ? curve : [...curve, first];
  const pointIds = sequence.map((pt) => editor.addEntity('IfcCartesianPoint', [[pt[0], pt[1]]]).expressId);
  const polylineId = editor.addEntity('IfcPolyline', [pointIds.map((id) => `#${id}`)]).expressId;
  return editor.addEntity('IfcArbitraryClosedProfileDef', [
    '.AREA.',
    null,
    `#${polylineId}`,
  ]).expressId;
}

/**
 * Emit an IfcExtrudedAreaSolid extruding `profileId` along local +Z
 * for `depth` metres. Standard prologue for any swept-solid element.
 */
export function emitExtrudedSolid(editor: StoreEditor, profileId: number, depth: number): number {
  const originPt = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${originPt}`, null, null]).expressId;
  const direction = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  return editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`,
    `#${axis}`,
    `#${direction}`,
    depth,
  ]).expressId;
}

/**
 * Emit a "Body" IfcShapeRepresentation + IfcProductDefinitionShape
 * pair from a single solid. Returns both ids so callers can record
 * them in their build result for downstream tooling.
 */
export function emitBodyRepresentation(
  editor: StoreEditor,
  bodyContextId: number,
  solidId: number,
): { shapeRepId: number; productShapeId: number } {
  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${bodyContextId}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    [`#${shapeRepId}`],
  ]).expressId;
  return { shapeRepId, productShapeId };
}

/**
 * Emit a fresh IfcRelContainedInSpatialStructure that anchors a single
 * element to its storey. Easier than mutating an existing rel — STEP
 * importers fold parallel rels back into one container at parse time.
 */
export function emitRelContainedInSpatialStructure(
  editor: StoreEditor,
  ownerHistoryId: number,
  elementId: number,
  storeyId: number,
): number {
  return editor.addEntity('IfcRelContainedInSpatialStructure', [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    null,
    null,
    [`#${elementId}`],
    `#${storeyId}`,
  ]).expressId;
}

/**
 * Build the leading attributes shared by every IfcElement subclass
 * (GlobalId → OwnerHistory → Name → Description → ObjectType →
 * ObjectPlacement → Representation → Tag). Callers append their
 * type-specific tail (PredefinedType, OperationType, etc.).
 */
export function ifcElementHeader(
  ownerHistoryId: number,
  placementId: number,
  productShapeId: number,
  params: { Name?: string; Description?: string; ObjectType?: string; Tag?: string },
  defaultName: string,
): Array<unknown> {
  return [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    params.Name ?? defaultName,
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
  ];
}
