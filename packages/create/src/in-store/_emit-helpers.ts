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

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';

const POINT_EPSILON = 1e-6;

/**
 * Guard for element-builder dimension params (Width, Depth, Height,
 * Thickness, FrameThickness, ...). A bare `value <= 0` check is `false`
 * for both `NaN` and `Infinity`, so those values sail past validation
 * and land as the literal strings `"NaN"`/`"Infinity"` in the emitted
 * `IfcExtrudedAreaSolid`/profile attributes — invalid IFC written with
 * no error. `column.ts` picked this up while closing the merge-roundtrip
 * gap from LTplus-AG/ifc-lite#592; every other builder needs the same
 * `Number.isFinite` guard, so it lives here once instead of as N copies
 * that can individually go stale.
 */
export function assertPositiveFinite(values: readonly number[], message: string): void {
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error(message);
  }
}

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
 * OwnerHistory STEP reference, or `$` when the model has none —
 * IfcRoot.OwnerHistory is OPTIONAL from IFC4 onward, and minimal files
 * (including ifc-lite's own exports) legitimately omit the entity.
 */
export function ownerHistoryRef(ownerHistoryId: number | null): string | null {
  return ownerHistoryId == null ? null : `#${ownerHistoryId}`;
}

/**
 * Emit a fresh IfcRelContainedInSpatialStructure that anchors a single
 * element to its storey. Easier than mutating an existing rel — STEP
 * importers fold parallel rels back into one container at parse time.
 * `random` seeds the rel's GlobalId (see `SpatialAnchor.guidRandom`).
 */
export function emitRelContainedInSpatialStructure(
  editor: StoreEditor,
  ownerHistoryId: number | null,
  elementId: number,
  storeyId: number,
  random?: RandomSource,
): number {
  return editor.addEntity('IfcRelContainedInSpatialStructure', [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
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
 * `random` seeds the element's GlobalId (see `SpatialAnchor.guidRandom`).
 */
export function ifcElementHeader(
  ownerHistoryId: number | null,
  placementId: number,
  productShapeId: number,
  params: { Name?: string; Description?: string; ObjectType?: string; Tag?: string },
  defaultName: string,
  random?: RandomSource,
): Array<unknown> {
  return [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
    params.Name ?? defaultName,
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
  ];
}

/** An RGB colour with channels in 0..1. */
export interface SurfaceStyleColor {
  red: number;
  green: number;
  blue: number;
  /** 1 is opaque. Written as `IfcSurfaceStyleShading.Transparency = 1 - alpha`. */
  alpha?: number;
}

/** Guards a caller's 0..255 or out-of-range channel from reaching STEP. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Transparency is `1 - alpha`, and binary floating point turns an alpha of 0.9
 * into `0.09999999999999998` in the STEP text. Four decimals is what
 * `@ifc-lite/export`'s demesh writer settles on for the same value.
 */
const TRANSPARENCY_DECIMALS = 4;

function roundTo(v: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}

/**
 * Emit `IfcColourRgb` -> `IfcSurfaceStyleShading` -> `IfcSurfaceStyle`.
 *
 * Returns the `IfcSurfaceStyle`, the id an `IfcStyledItem` should point at, and
 * every entity in the chain. The first two differ on IFC2X3, which has no
 * `IfcStyleAssignmentSelect`: there `IfcStyledItem.Styles` is a set of
 * `IfcPresentationStyleAssignment`, the wrapper IFC4 deprecated and IFC4X3
 * removed.
 *
 * `schemaVersion` is the schema the chain is built FOR. Callers that will
 * export to a different schema than the model was parsed from have to pass the
 * target, because this shape is not schema-neutral. IFC2X3 is the only version
 * that needs the wrapper, so the test is for it by name and every later schema
 * takes the default.
 */
export function emitSurfaceStyle(
  editor: StoreEditor,
  schemaVersion: string,
  color: SurfaceStyleColor,
  name?: string,
): { surfaceStyleId: number; styleRefId: number; chainIds: number[] } {
  const red = clamp01(color.red);
  const green = clamp01(color.green);
  const blue = clamp01(color.blue);
  const alpha = clamp01(color.alpha ?? 1);

  const colour = editor.addEntity('IfcColourRgb', [
    null, { real: red }, { real: green }, { real: blue },
  ]);
  const shading = editor.addEntity('IfcSurfaceStyleShading', [
    `#${colour.expressId}`,
    { real: roundTo(1 - alpha, TRANSPARENCY_DECIMALS) },
  ]);
  const surfaceStyle = editor.addEntity('IfcSurfaceStyle', [
    name ?? null,
    '.BOTH.',
    [`#${shading.expressId}`],
  ]);

  const chainIds = [colour.expressId, shading.expressId, surfaceStyle.expressId];

  let styleRefId = surfaceStyle.expressId;
  if (schemaVersion === 'IFC2X3') {
    const assignment = editor.addEntity(
      'IfcPresentationStyleAssignment', [[`#${surfaceStyle.expressId}`]],
    );
    styleRefId = assignment.expressId;
    chainIds.push(assignment.expressId);
  }

  // chainIds so a caller that later finds nothing referencing this style can
  // take the whole chain back out rather than leaving it orphaned.
  return { surfaceStyleId: surfaceStyle.expressId, styleRefId, chainIds };
}
