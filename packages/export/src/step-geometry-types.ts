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
 * The set itself, at module scope rather than rebuilt per call.
 *
 * `isGeometryEntity` runs once per entity, through `isGeometryExcluded`, the
 * source-iteration skip and `step-overlay-entities.ts` — so constructing this
 * inside the function allocated a 31-string `Set` per entity on any export
 * that excludes geometry. It was written that way as a private method and
 * moved here verbatim; being a free function is what makes hoisting it
 * trivial and obviously safe.
 *
 * Named PRIMITIVE deliberately. `@ifc-lite/parser` exports a `GEOMETRY_TYPES`
 * of its own holding BUILDING ELEMENTS — `IFCWALL`, `IFCDOOR`, `IFCCOVERING`
 * — which is close to the opposite of this set's contents: representation
 * primitives like `IFCCARTESIANPOINT` and `IFCEXTRUDEDAREASOLID`. The two
 * never collide as imports, since this one is module-private, but they
 * collide for anyone grepping the symbol, and "the geometry types" is exactly
 * the phrase that would make a reader reach for the wrong one.
 */
const GEOMETRY_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
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

/** Check if an entity type is a geometry-related type. */
export function isGeometryEntity(type: string): boolean {
  return GEOMETRY_PRIMITIVE_TYPES.has(type);
}
