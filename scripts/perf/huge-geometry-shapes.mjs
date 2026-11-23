/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP writers for the huge-geometry stress generator (huge-geometry-gen.mjs).
 *
 * Every function takes a `w` writer `{ rec(body) -> id, shared }` where
 * `shared` holds the header entities (origin, axes, body context, styles) and
 * returns the entity ids it wrote. Geometry is IFC4 only:
 *
 *   box       IfcExtrudedAreaSolid of an IfcRectangleProfileDef: 12 triangles.
 *   cylinder  IfcExtrudedAreaSolid of an IfcCircleProfileDef: curved, the
 *             kernel picks the tessellation (triangle count not known here).
 *   mesh      IfcTriangulatedFaceSet ellipsoid of exactly `meshTriangles(t)`
 *             triangles, the dense or curved case.
 *   voided    an extruded wall body cut by `openings` IfcOpeningElements via
 *             IfcRelVoidsElement, the CSG case (count decided by the kernel).
 *
 * Repeated geometry is written once as an IfcRepresentationMap per prototype
 * and referenced by an IfcMappedItem per element (the instancing path);
 * unique geometry is written per element with seeded dimensions and jitter so
 * no dedup or instancing can collapse it.
 */

import { ellipsoid, real } from './gen-dense-ifc.mjs';

export const SHAPES = Object.freeze(['box', 'cylinder', 'mesh', 'voided']);

/** Ellipsoid ring/segment counts for roughly `target` triangles (at least 24). */
export function meshGrid(target) {
  const segs = Math.max(4, Math.round(Math.sqrt(Math.max(1, target))));
  const rings = Math.max(2, Math.round(segs / 2));
  return { rings, segs, triangles: 2 * segs * (rings - 1) };
}

/** Exact triangles a shape produces, or null when the geometry kernel decides. */
export function shapeTriangles(part) {
  if (part.shape === 'box') return 12;
  if (part.shape === 'mesh') return meshGrid(part.tris).triangles;
  return null;
}

/** Write the header entities every shape needs; returns the `shared` table. */
export function writeShared(rec, palette) {
  const origin = rec('IFCCARTESIANPOINT((0.,0.,0.))');
  const zdir = rec('IFCDIRECTION((0.,0.,1.))');
  const xdir = rec('IFCDIRECTION((1.,0.,0.))');
  const ax = rec(`IFCAXIS2PLACEMENT3D(#${origin},#${zdir},#${xdir})`);
  const o2 = rec('IFCCARTESIANPOINT((0.,0.))');
  const ax2 = rec(`IFCAXIS2PLACEMENT2D(#${o2},$)`);
  const ctx = rec(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${ax},$)`);
  const body = rec(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const cto = rec(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${origin},$,$)`);
  const styles = palette.map(([r, g, b]) => {
    const colour = rec(`IFCCOLOURRGB($,${real(r)},${real(g)},${real(b)})`);
    const shading = rec(`IFCSURFACESTYLESHADING(#${colour},0.)`);
    return rec(`IFCSURFACESTYLE($,.BOTH.,(#${shading}))`);
  });
  return { origin, zdir, xdir, ax, ax2, ctx, body, cto, styles };
}

/** One placement relative to `parent` at (x, y, z); returns the IfcLocalPlacement id. */
export function placement(rec, parent, x, y, z) {
  const loc = rec(`IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`);
  const ax = rec(`IFCAXIS2PLACEMENT3D(#${loc},$,$)`);
  return rec(`IFCLOCALPLACEMENT(${parent ? `#${parent}` : '$'},#${ax})`);
}

function extrudedBox(w, x, y, depth, at) {
  const { rec, shared } = w;
  const pos = at ? rec(`IFCAXIS2PLACEMENT3D(#${rec(`IFCCARTESIANPOINT((${real(at[0])},${real(at[1])},${real(at[2])}))`)},$,$)`) : shared.ax;
  const prof = rec(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${shared.ax2},${real(x)},${real(y)})`);
  return rec(`IFCEXTRUDEDAREASOLID(#${prof},#${pos},#${shared.zdir},${real(depth)})`);
}

/**
 * Write one geometric item of `part` with dimensions drawn from `rand`.
 * Returns `{ item, repType }`. `voided` writes only the wall body here; its
 * openings are written by `writeOpenings` once the wall element exists.
 */
export function writeItem(w, part, rand) {
  const { rec } = w;
  if (part.shape === 'box') {
    return { item: extrudedBox(w, 0.6 + 1.6 * rand(), 0.6 + 1.6 * rand(), 0.2 + 2.4 * rand()), repType: 'SweptSolid' };
  }
  if (part.shape === 'cylinder') {
    const prof = rec(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${w.shared.ax2},${real(0.15 + 0.35 * rand())})`);
    return { item: rec(`IFCEXTRUDEDAREASOLID(#${prof},#${w.shared.ax},#${w.shared.zdir},${real(2.6 + 0.6 * rand())})`), repType: 'SweptSolid' };
  }
  if (part.shape === 'mesh') {
    const { rings, segs } = meshGrid(part.tris);
    const { pts, tris } = ellipsoid(rand, rings, segs, 0.5 + 0.6 * rand(), 0.5 + 0.6 * rand(), 0.6 + 0.8 * rand(), 0.05);
    const pl = rec(`IFCCARTESIANPOINTLIST3D((${pts.map(([x, y, z]) => `(${real(x)},${real(y)},${real(z + 1.5)})`).join(',')}))`);
    const item = rec(`IFCTRIANGULATEDFACESET(#${pl},$,.T.,(${tris.map(([i, j, k]) => `(${i + 1},${j + 1},${k + 1})`).join(',')}),$)`);
    return { item, repType: 'Tessellation' };
  }
  if (part.shape === 'voided') {
    // Wall body centred on the placement: 2.8 long, 0.3 thick, 2.8 high.
    return { item: extrudedBox(w, 2.8, 0.3, 2.8), repType: 'SweptSolid' };
  }
  throw new Error(`unknown shape ${part.shape}`);
}

/** Body representation + product shape around `item`, styled with palette entry `style`. */
export function writeProductShape(w, item, repType, style) {
  const { rec, shared } = w;
  if (style !== null) rec(`IFCSTYLEDITEM(#${item},(#${shared.styles[style]}),$)`);
  const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','${repType}',(#${item}))`);
  return rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
}

/** One IfcRepresentationMap (a prototype) for `part`; returns the map id. */
export function writePrototype(w, part, rand, style) {
  const { rec, shared } = w;
  const { item, repType } = writeItem(w, part, rand);
  rec(`IFCSTYLEDITEM(#${item},(#${shared.styles[style]}),$)`);
  const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','${repType}',(#${item}))`);
  return rec(`IFCREPRESENTATIONMAP(#${shared.ax},#${rep})`);
}

/** Product shape of one occurrence of prototype `map`. */
export function writeMappedShape(w, map) {
  const { rec, shared } = w;
  const mi = rec(`IFCMAPPEDITEM(#${map},#${shared.cto})`);
  const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','MappedRepresentation',(#${mi}))`);
  return rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
}

/**
 * `count` IfcOpeningElements through the wall `wall` (placed at `wallPlacement`),
 * spread along its length, each voiding it via IfcRelVoidsElement.
 */
export function writeOpenings(w, wall, wallPlacement, count, rand, gid, oh) {
  const { rec } = w;
  for (let k = 0; k < count; k++) {
    const along = -1.4 + (2.8 * (k + 0.5)) / count;
    const width = Math.min(2.4 / count, 0.5 + 0.6 * rand());
    const pl = placement(rec, wallPlacement, along, 0, 0.3 + 0.5 * rand());
    const solid = extrudedBox(w, width, 0.6, 1.2 + 0.6 * rand());
    const rep = rec(`IFCSHAPEREPRESENTATION(#${w.shared.body},'Body','SweptSolid',(#${solid}))`);
    const pds = rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const opening = rec(`IFCOPENINGELEMENT('${gid()}',#${oh},$,$,$,#${pl},#${pds},$,.OPENING.)`);
    rec(`IFCRELVOIDSELEMENT('${gid()}',#${oh},$,$,#${wall},#${opening})`);
  }
}
