/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The entity types a STEP export treats as geometry.
 *
 * Split out of `StepExporter` for #2475. It was a private method only by
 * habit: it reads nothing off the instance, so every consumer already
 * received it as an injected callback rather than calling it through an
 * exporter. Moving it changes no call site -- the three inside
 * `step-exporter.ts` stop wrapping it in an arrow, and that is all.
 *
 * The set is the definition, not a cache of one. `includegeometry-header-count.test.ts`
 * and `retype-geometry-boundary.test.ts` pin what belongs in it, and
 * `reference-collector.ts` documents the one place a type in this set is
 * still reachable when geometry is excluded.
 */

/**
 * Check if an entity type is a geometry-related type
 */
export function isGeometryEntity(type: string): boolean {
  const geometryTypes = new Set([
    'IFCCARTESIANPOINT',
    'IFCDIRECTION',
    'IFCAXIS2PLACEMENT2D',
    'IFCAXIS2PLACEMENT3D',
    'IFCLOCALPLACEMENT',
    'IFCSHAPEREPRESENTATION',
    'IFCPRODUCTDEFINITIONSHAPE',
    'IFCGEOMETRICREPRESENTATIONCONTEXT',
    'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    'IFCEXTRUDEDAREASOLID',
    'IFCFACETEDBREP',
    'IFCPOLYLOOP',
    'IFCFACE',
    'IFCFACEOUTERBOUND',
    'IFCCLOSEDSHELL',
    'IFCRECTANGLEPROFILEDEF',
    'IFCCIRCLEPROFILEDEF',
    'IFCARBITRARYCLOSEDPROFILEDEF',
    'IFCPOLYLINE',
    'IFCTRIMMEDCURVE',
    'IFCBSPLINECURVE',
    'IFCBSPLINESURFACE',
    'IFCTRIANGULATEDFACESET',
    'IFCPOLYGONALFACE',
    'IFCINDEXEDPOLYGONALFACE',
    'IFCPOLYGONALFACESET',
    'IFCSTYLEDITEM',
    'IFCPRESENTATIONSTYLEASSIGNMENT',
    'IFCSURFACESTYLE',
    'IFCSURFACESTYLERENDERING',
    'IFCCOLOURRGB',
  ]);
  return geometryTypes.has(type);
}
