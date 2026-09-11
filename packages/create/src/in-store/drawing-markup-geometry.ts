/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry emitters local to `drawing-markup.ts`, kept out of the shared
 * `_emit-helpers.ts` deliberately: annotation curves/placements are a
 * different shape than the swept-solid prologue every element builder
 * shares (bare `IfcPolyline`, not a closed profile; an `Annotation`
 * `IfcShapeRepresentation`, not `Body`), so folding them into the shared
 * file would grow it for callers that never touch markup.
 */

import type { StoreEditor } from '@ifc-lite/mutations';

const POINT_EPSILON = 1e-6;

/**
 * Emit an `IfcPolyline` through 2D points, in order. When `close` is true
 * and the input isn't already closed (first/last within epsilon), the first
 * point is appended again — same auto-close rule `_emit-helpers.ts`'s
 * `emitPolygonProfile` uses, minus the `IfcArbitraryClosedProfileDef`
 * wrapper: markup curves are annotation geometry, not extrusion profiles.
 */
export function emitMarkupPolyline(
  editor: StoreEditor,
  points: ReadonlyArray<readonly [number, number]>,
  close: boolean,
): number {
  if (points.length < 2) {
    throw new Error('emitMarkupPolyline: needs at least 2 points');
  }
  let sequence: ReadonlyArray<readonly [number, number]> = points;
  if (close) {
    const first = points[0];
    const last = points[points.length - 1];
    const alreadyClosed =
      Math.abs(first[0] - last[0]) < POINT_EPSILON && Math.abs(first[1] - last[1]) < POINT_EPSILON;
    sequence = alreadyClosed ? points : [...points, first];
  }
  const pointIds = sequence.map((pt) => editor.addEntity('IfcCartesianPoint', [[pt[0], pt[1]]]).expressId);
  return editor.addEntity('IfcPolyline', [pointIds.map((id) => `#${id}`)]).expressId;
}

/**
 * Emit an `IfcAxis2Placement2D` at a 2D point (no rotation) — the `Placement`
 * a text literal needs.
 */
export function emitMarkupPoint2DPlacement(editor: StoreEditor, point: readonly [number, number]): number {
  const originPt = editor.addEntity('IfcCartesianPoint', [[point[0], point[1]]]).expressId;
  return editor.addEntity('IfcAxis2Placement2D', [`#${originPt}`, null]).expressId;
}

/**
 * Emit a fresh `IfcGeometricRepresentationSubContext` for markup geometry,
 * chained to `parentContextId` (the model's root 3D
 * `IfcGeometricRepresentationContext`). `targetView` is written verbatim
 * into `TargetView` (dot-wrapped enum, e.g. `'PLAN_VIEW'` → `.PLAN_VIEW.`).
 *
 * `CoordinateSpaceDimension` / `Precision` / `WorldCoordinateSystem` /
 * `TrueNorth` are DERIVE-redeclared on `IfcGeometricRepresentationSubContext`
 * in the IFC4 EXPRESS schema (`Ifc4.RepresentationResource`) — not given
 * their own values, but STEP still reserves their positional slots with the
 * `*` derived-attribute token (`packages/export/src/step-serialization.ts`'s
 * `serializeStepValue` passes a literal `'*'` through unquoted), which is
 * how mainstream IFC exporters emit this entity.
 */
export function emitMarkupSubContext(
  editor: StoreEditor,
  parentContextId: number,
  targetView: 'PLAN_VIEW' | 'SECTION_VIEW',
  contextIdentifier = 'Annotation',
): number {
  return editor.addEntity('IfcGeometricRepresentationSubContext', [
    contextIdentifier,
    'Model',
    '*',
    '*',
    '*',
    '*',
    `#${parentContextId}`,
    null,
    `.${targetView}.`,
    null,
  ]).expressId;
}

/**
 * Emit an `Annotation` `IfcShapeRepresentation` + `IfcProductDefinitionShape`
 * wrapping one representation item, for `IfcAnnotation.Representation`.
 */
export function emitMarkupRepresentation(
  editor: StoreEditor,
  contextId: number,
  representationType: string,
  itemId: number,
): { shapeRepId: number; productShapeId: number } {
  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${contextId}`,
    'Annotation',
    representationType,
    [`#${itemId}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    [`#${shapeRepId}`],
  ]).expressId;
  return { shapeRepId, productShapeId };
}
