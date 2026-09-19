/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rectangle-extrusion edits for issue #4955: `thickened`, `splitLength` and
 * the `insertedNearby` control all act on ONE extruded rectangle the element
 * owns outright, read out of either profile spelling into a single model and
 * written back in the spelling it came in. Split out of `edits.mjs` for
 * size; the locality rules are the same as there.
 */

import {
  cloneElement,
  emit,
  exclusiveSolids,
  isExclusivelyOwnedBy,
  reachable,
  refAt,
  renameElement,
  PRODUCT_REPRESENTATION,
} from './edits.mjs';
import { real, referencesIn, rewriteReferences, setArg, splitArgs } from './step-file.mjs';

/** `IfcRectangleProfileDef` slots: (ProfileType, ProfileName, Position, XDim, YDim). */
const RECT_POSITION = 2;
const RECT_XDIM = 3;
const RECT_YDIM = 4;
/** `IfcArbitraryClosedProfileDef` slots: (ProfileType, ProfileName, OuterCurve). */
const ARBITRARY_OUTER = 2;
/** `IfcExtrudedAreaSolid` slots: (SweptArea, Position, ExtrudedDirection, Depth). */
const SOLID_PROFILE = 0;
const SOLID_DEPTH = 3;
/** `IfcAxis2Placement2D` slots: (Location, RefDirection). */
const PLACEMENT2D_LOCATION = 0;
const PLACEMENT2D_REFDIR = 1;

/** Coordinates of a point / direction statement. */
function coordinates(statement) {
  const inner = statement.args.trim().replace(/^\(/, '').replace(/\)$/, '');
  return splitArgs(inner).map((value) => Number.parseFloat(value));
}

/** Relative tolerance for "these four points are a rectangle". */
const RECTANGLE_EPSILON = 1e-6;

/**
 * Read a 4-corner rectangle out of a closed 2D curve — an `IfcPolyline` or an
 * `IfcIndexedPolyCurve` over an `IfcCartesianPointList2D` with straight
 * segments only — as `{ centre, u, v, a, b }`: centre, unit axes along the
 * first two edges, and half-extents. Undefined for anything else.
 *
 * Authoring tools export a wall's rectangle as an arbitrary closed profile
 * far more often than as an `IfcRectangleProfileDef` (rvt01 has 2 of the
 * latter and several hundred of the former), so a fixture that only knew the
 * named profile would have no split population on two of three models.
 */
function rectangleOfCurve(index, curveId) {
  const curve = index.byId.get(curveId);
  if (!curve) return undefined;
  let points;
  if (curve.type === 'IFCPOLYLINE') {
    points = referencesIn(curve.args).map((id) => coordinates(index.byId.get(id)));
  } else if (curve.type === 'IFCINDEXEDPOLYCURVE') {
    const parts = splitArgs(curve.args);
    const list = index.byId.get(refAt(curve, 0));
    if (list?.type !== 'IFCCARTESIANPOINTLIST2D') return undefined;
    // `((x,y),(x,y),...)`: strip the outer pair, split the tuples, then each.
    const outer = list.args.trim();
    if (!outer.startsWith('(') || !outer.endsWith(')')) return undefined;
    points = splitArgs(outer.slice(1, -1)).map((tuple) =>
      splitArgs(tuple.trim().replace(/^\(/, '').replace(/\)$/, '')).map(Number.parseFloat),
    );
    // Segments: `$` means "straight lines between consecutive points". An
    // explicit list is accepted only when it is exactly that walk spelled out
    // in `IFCLINEINDEX`es — an arc index, or a reordering, is not a rectangle.
    if (parts[1] !== '$') {
      if (/IFCARCINDEX/.test(parts[1])) return undefined;
      const walk = (parts[1].match(/\d+/g) ?? []).map(Number);
      const expected = [];
      for (let i = 1; i <= points.length; i++) expected.push(i, i === points.length ? 1 : i + 1);
      const open = expected.slice(0, -2);
      if (walk.join(',') !== expected.join(',') && walk.join(',') !== open.join(',')) {
        return undefined;
      }
    }
  } else return undefined;
  if (points.some((point) => point.length < 2 || point.some((value) => !Number.isFinite(value)))) {
    return undefined;
  }
  // A closed polyline repeats its first point; drop the repeat.
  if (points.length === 5 && samePoint(points[0], points[4])) points = points.slice(0, 4);
  if (points.length !== 4) return undefined;
  const [p0, p1, p2, p3] = points;
  const e1 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e3 = [p3[0] - p2[0], p3[1] - p2[1]];
  const e4 = [p0[0] - p3[0], p0[1] - p3[1]];
  const l1 = Math.hypot(e1[0], e1[1]);
  const l2 = Math.hypot(e2[0], e2[1]);
  if (l1 <= 0 || l2 <= 0) return undefined;
  const scale = Math.max(l1, l2);
  const near = (a, b) => Math.abs(a - b) <= RECTANGLE_EPSILON * scale;
  if (!near(e1[0] * e2[0] + e1[1] * e2[1], 0)) return undefined;
  if (!near(e3[0], -e1[0]) || !near(e3[1], -e1[1])) return undefined;
  if (!near(e4[0], -e2[0]) || !near(e4[1], -e2[1])) return undefined;
  return {
    centre: [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2],
    u: [e1[0] / l1, e1[1] / l1],
    v: [e2[0] / l2, e2[1] / l2],
    a: l1 / 2,
    b: l2 / 2,
    closed: curve.type === 'IFCPOLYLINE' && referencesIn(curve.args).length === 5,
    curveType: curve.type,
  };
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) <= RECTANGLE_EPSILON && Math.abs(a[1] - b[1]) <= RECTANGLE_EPSILON;
}

/**
 * The ONE extruded rectangle this element owns outright, or undefined.
 *
 * Exactly one solid, deliberately: a multi-layer wall is several extrusions
 * of one profile each, and thickening every layer by 1.25 produces overlapping
 * layers whose union box is not the clean `V_old / V_new` the footprint
 * profile is specified against. The profile must be exclusively owned too —
 * profiles are shared across occurrences as readily as curves are (see
 * {@link isExclusivelyOwnedBy}).
 *
 * Two spellings of a rectangle are read into ONE model `{ centre, u, v, a, b }`
 * in the profile's 2D frame: an `IfcRectangleProfileDef` (centre and axes from
 * its `Position`, half-extents from `XDim`/`YDim`) and an
 * `IfcArbitraryClosedProfileDef` whose outer curve is four corners at right
 * angles. `writeRectangle` writes the same model back in the profile's own
 * spelling, so a thickened or split wall keeps the representation style its
 * exporter chose.
 */
export function ownedRectangleExtrusion(index, productId) {
  const solids = exclusiveSolids(index, productId);
  if (solids.length !== 1) return undefined;
  const solidId = solids[0];
  const solid = index.byId.get(solidId);
  const profileId = refAt(solid, SOLID_PROFILE);
  if (profileId === undefined) return undefined;
  const profile = index.byId.get(profileId);
  if (!profile || !isExclusivelyOwnedBy(index, profileId, productId)) return undefined;
  const depth = Number.parseFloat(splitArgs(solid.args)[SOLID_DEPTH]);
  if (!Number.isFinite(depth) || depth <= 0) return undefined;

  let rectangle;
  if (profile.type === 'IFCRECTANGLEPROFILEDEF') {
    const parts = splitArgs(profile.args);
    const xDim = Number.parseFloat(parts[RECT_XDIM]);
    const yDim = Number.parseFloat(parts[RECT_YDIM]);
    if (!(xDim > 0) || !(yDim > 0)) return undefined;
    const positionId = refAt(profile, RECT_POSITION);
    const position = positionId === undefined ? undefined : index.byId.get(positionId);
    if (position?.type !== 'IFCAXIS2PLACEMENT2D') return undefined;
    const location = index.byId.get(refAt(position, PLACEMENT2D_LOCATION));
    if (location?.type !== 'IFCCARTESIANPOINT') return undefined;
    const refDirId = refAt(position, PLACEMENT2D_REFDIR);
    const refDir = refDirId === undefined ? [1, 0] : coordinates(index.byId.get(refDirId));
    const norm = Math.hypot(refDir[0], refDir[1]) || 1;
    const u = [refDir[0] / norm, refDir[1] / norm];
    rectangle = {
      centre: coordinates(location).slice(0, 2),
      u,
      v: [-u[1], u[0]],
      a: xDim / 2,
      b: yDim / 2,
      positionId,
    };
  } else if (profile.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
    const curveId = refAt(profile, ARBITRARY_OUTER);
    if (curveId === undefined) return undefined;
    rectangle = rectangleOfCurve(index, curveId);
    if (!rectangle) return undefined;
  } else return undefined;

  return { solidId, profileId, depth, ...rectangle };
}

/**
 * Write a rectangle model back into the profile it was read from.
 *
 * Fresh nodes only: a new `IfcAxis2Placement2D` and point for the named
 * profile, a new curve and points for the arbitrary one. The old placement or
 * curve may be shared with other occurrences, and it is left exactly as it
 * was; only the owned profile's pointer to it changes.
 */
function writeRectangle(file, index, profileId, model) {
  const profile = index.byId.get(profileId);
  if (profile.type === 'IFCRECTANGLEPROFILEDEF') {
    const template = index.byId.get(model.positionId);
    const pointId = emit(file, index, 'IFCCARTESIANPOINT', `(${model.centre.map(real).join(',')})`);
    const placementId = emit(
      file,
      index,
      'IFCAXIS2PLACEMENT2D',
      setArg(template, PLACEMENT2D_LOCATION, `#${pointId}`).args,
    );
    profile.args = setArg(profile, RECT_POSITION, `#${placementId}`).args;
    profile.args = setArg(profile, RECT_XDIM, real(model.a * 2)).args;
    profile.args = setArg(profile, RECT_YDIM, real(model.b * 2)).args;
    return;
  }
  const { centre: c, u, v, a, b } = model;
  const corners = [
    [c[0] - a * u[0] - b * v[0], c[1] - a * u[1] - b * v[1]],
    [c[0] + a * u[0] - b * v[0], c[1] + a * u[1] - b * v[1]],
    [c[0] + a * u[0] + b * v[0], c[1] + a * u[1] + b * v[1]],
    [c[0] - a * u[0] + b * v[0], c[1] - a * u[1] + b * v[1]],
  ];
  let curveId;
  if (model.curveType === 'IFCPOLYLINE') {
    const ids = corners.map((corner) =>
      emit(file, index, 'IFCCARTESIANPOINT', `(${corner.map(real).join(',')})`),
    );
    if (model.closed) ids.push(ids[0]);
    curveId = emit(file, index, 'IFCPOLYLINE', `(${ids.map((id) => `#${id}`).join(',')})`);
  } else {
    const listId = emit(
      file,
      index,
      'IFCCARTESIANPOINTLIST2D',
      `((${corners.map((corner) => corner.map(real).join(',')).join('),(')}))`,
    );
    curveId = emit(file, index, 'IFCINDEXEDPOLYCURVE', `#${listId},$,.F.`);
  }
  profile.args = setArg(profile, ARBITRARY_OUTER, `#${curveId}`).args;
}

/**
 * Scale the SHORTER profile axis of the element's owned rectangle extrusion.
 *
 * The shorter axis of a wall's or a beam's profile is its thickness; the
 * rectangle stays centred, so the old box nests inside the new one and the
 * box IoU is exactly `1 / scale` whichever face moved — the arithmetic the
 * `footprint` successor profile is written against.
 */
export function thickenElement(file, index, productId, scale) {
  const owned = ownedRectangleExtrusion(index, productId);
  if (!owned) return false;
  const model = owned.a < owned.b ? { ...owned, a: owned.a * scale } : { ...owned, b: owned.b * scale };
  writeRectangle(file, index, owned.profileId, model);
  return true;
}

/**
 * Copy the subgraph under `rootId`, cloning every node the product owns
 * outright and KEEPING every shared node as a reference.
 *
 * Copy-on-write, in effect: a shared `IfcDirection`, a shared placement, a
 * shared curve is exactly as shared afterwards as it was before, and only the
 * exclusively-owned chain — which is the only chain a later edit is allowed
 * to write — gets a private copy. Presentation referrers do not count as
 * sharing, for the reason {@link structuralRefCount} gives.
 */
function cloneOwnedSubgraph(file, index, rootId, productId) {
  const copies = new Map();
  const copy = (id) => {
    const existing = copies.get(id);
    if (existing !== undefined) return existing;
    const statement = index.byId.get(id);
    if (!statement) return id;
    if (id !== rootId && !isExclusivelyOwnedBy(index, id, productId)) return id;
    const map = new Map();
    for (const child of referencesIn(statement.args)) {
      if (child === id) continue;
      map.set(child, copy(child));
    }
    const cloneId = emit(file, index, statement.type, rewriteReferences(statement.args, map));
    copies.set(id, cloneId);
    return cloneId;
  };
  return copy(rootId);
}

/**
 * Split an element into two products of half length, tiling the original.
 *
 * The long axis of the owned rectangle is halved and each half is re-centred
 * a quarter length either side of the old centre — in the profile's OWN 2D
 * frame, so no 3D placement arithmetic is involved and no placement is
 * edited. The second product is a clone enrolled in every list the original
 * sits in (containment, type, property sets, material), with a private copy
 * of the owned shape chain and the same (shared, unedited)
 * `IfcLocalPlacement`. Both halves are renamed: an authoring tool that splits
 * a wall names the results afresh, and two halves under the original name
 * would land in the original's data bucket and hand tier 3 a coin flip between
 * two equidistant centres.
 *
 * Returns the clone's express id, or undefined when the element is not
 * eligible. The volumes tile exactly, so a geometry pass that proves both
 * halves closed lets the split detector reach `verified`.
 */
export function splitElementLength(file, index, productId, names) {
  const owned = ownedRectangleExtrusion(index, productId);
  if (!owned) return undefined;
  const product = index.byId.get(productId);
  const shapeId = refAt(product, PRODUCT_REPRESENTATION);

  // The clone first, while the original's chain is still what it was: the
  // copy inherits the full-length profile and is then trimmed like the original.
  const cloneId = cloneElement(file, index, productId, { name: names[1] });
  const cloneShapeId = cloneOwnedSubgraph(file, index, shapeId, productId);
  const clone = index.byId.get(cloneId);
  clone.args = setArg(clone, PRODUCT_REPRESENTATION, `#${cloneShapeId}`).args;
  renameElement(index, productId, names[0]);

  const alongU = owned.a >= owned.b;
  const axis = alongU ? owned.u : owned.v;
  const half = alongU ? owned.a : owned.b;
  const halves = [
    [owned.profileId, -1],
    [cloneOwnedProfile(index, cloneShapeId), +1],
  ];
  for (const [profileId, sign] of halves) {
    const centre = [
      owned.centre[0] + (sign * half * axis[0]) / 2,
      owned.centre[1] + (sign * half * axis[1]) / 2,
    ];
    const model = alongU ? { ...owned, centre, a: half / 2 } : { ...owned, centre, b: half / 2 };
    writeRectangle(file, index, profileId, model);
  }
  return cloneId;
}

/** The single profile under a freshly cloned shape. */
function cloneOwnedProfile(index, shapeId) {
  for (const id of reachable(index, [shapeId])) {
    const type = index.byId.get(id)?.type;
    if (type === 'IFCRECTANGLEPROFILEDEF' || type === 'IFCARBITRARYCLOSEDPROFILEDEF') return id;
  }
  throw new Error(`cloned shape #${shapeId} carries no rectangle profile`);
}

/**
 * Shrink an owned rectangle extrusion to `factor` of its size on every axis.
 *
 * Takes the model {@link ownedRectangleExtrusion} resolved EARLIER, because
 * the one caller (`insertedNearby`) applies it to a clone of an element that
 * has since been deleted — the reverse-reference index is built once per
 * model and would answer the ownership question about the dead original.
 * The rectangle stays centred and the extrusion keeps its base plane, so the
 * shrunken solid lies entirely inside the original's box.
 */
export function shrinkOwnedExtrusion(file, index, owned, factor) {
  const solid = index.byId.get(owned.solidId);
  writeRectangle(file, index, owned.profileId, { ...owned, a: owned.a * factor, b: owned.b * factor });
  solid.args = setArg(solid, SOLID_DEPTH, real(owned.depth * factor)).args;
}
