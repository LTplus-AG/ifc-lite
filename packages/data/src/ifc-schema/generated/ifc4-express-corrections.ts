/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where `entities-ifc4.ts` (C# `SchemaInfo`) disagrees with the IFC4 EXPRESS
 * schema (#5204). Applied by `../entities-ifc4-express.ts`.
 *
 * DO NOT EDIT - regenerate with
 *   node scripts/generate-ifc4-express-corrections.mjs
 */

/** Rows with attributes that IFC4 EXPRESS does not declare: dropped. */
export const IFC4_UNDECLARED_ENTITIES: ReadonlySet<string> = new Set([
  'IfcAlignment',
  'IfcAlignment2DHorizontal',
  'IfcAlignment2DHorizontalSegment',
  'IfcAlignment2DSegment',
  'IfcAlignment2DVerSegCircularArc',
  'IfcAlignment2DVerSegLine',
  'IfcAlignment2DVerSegParabolicArc',
  'IfcAlignment2DVertical',
  'IfcAlignment2DVerticalSegment',
  'IfcAlignmentCurve',
  'IfcCircularArcSegment2D',
  'IfcCurveSegment2D',
  'IfcDistanceExpression',
  'IfcLineSegment2D',
  'IfcLinearPlacement',
  'IfcLinearPositioningElement',
  'IfcOffsetCurve',
  'IfcOffsetCurveByDistances',
  'IfcOrientationExpression',
  'IfcPositioningElement',
  'IfcReferent',
  'IfcSectionedSolid',
  'IfcSectionedSolidHorizontal',
  'IfcTransitionCurveSegment2D',
  'IfcTriangulatedIrregularNetwork',
]);

/** Declared rows whose attributes, parent or abstractness differ from EXPRESS. */
export const IFC4_EXPRESS_OVERRIDES: Readonly<Record<string, {
  readonly attributes?: readonly string[];
  readonly parent?: string;
  readonly abstract?: boolean;
}>> = {
  IfcCartesianPointList2D: { attributes: ['CoordList'] },
  IfcCartesianPointList3D: { attributes: ['CoordList'] },
  IfcOffsetCurve2D: { parent: 'IfcCurve' },
  IfcOffsetCurve3D: { parent: 'IfcCurve' },
};
