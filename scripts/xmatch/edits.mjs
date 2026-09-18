/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The individual STEP edits the mutation program applies to one element, and
 * the eligibility tests that decide whether an element can take an edit at all.
 *
 * Every edit here is *local*: it must change the chosen element and nothing
 * else. IFC files share aggressively — one `IfcCartesianPoint` can be the
 * origin of a hundred placements, one `IfcExtrudedAreaSolid` can be mapped onto
 * every instance of a type — so an edit that writes through a shared node would
 * silently mutate elements the answer key records as untouched, and the fixture
 * would then be measuring a model nobody described. Each edit either CLONES the
 * nodes it needs to change (move) or refuses to run unless the node it writes
 * is referenced exactly once (reshape).
 */

import {
  quote,
  real,
  referencesIn,
  rewriteReferences,
  setArg,
  splitArgs,
  unquote,
} from './step-file.mjs';

/** IfcProduct attribute slots (IFC2X3 and IFC4 agree on all seven). */
const PRODUCT_NAME = 2;
export const PRODUCT_PLACEMENT = 5;
export const PRODUCT_REPRESENTATION = 6;

/**
 * An index over a parsed file: id lookup, and the reverse reference map that
 * every eligibility test is decided from.
 *
 * `refs.get(id)` lists each statement that mentions `#id`, and whether the
 * mention sits at a TOP-LEVEL attribute (`scalar: true`, e.g.
 * `IfcRelVoidsElement.RelatingBuildingElement`) or inside a list
 * (`scalar: false`, e.g. `IfcRelDefinesByProperties.RelatedObjects`). The
 * distinction decides deletability: an id can be pruned out of a list, but
 * blanking a scalar attribute changes what the referring entity MEANS.
 */
export function indexModel(file) {
  const byId = new Map();
  const refs = new Map();
  let nextId = 0;
  for (const statement of file.statements) {
    byId.set(statement.id, statement);
    if (statement.id >= nextId) nextId = statement.id + 1;
  }
  for (const statement of file.statements) {
    const parts = splitArgs(statement.args);
    for (let position = 0; position < parts.length; position++) {
      const part = parts[position];
      const mentioned = referencesIn(part);
      if (mentioned.length === 0) continue;
      const scalar = /^#\d+$/.test(part);
      // A plain parenthesised list is the only shape an id can be pruned out
      // of or appended to; `IFCPARAMETERVALUE(#3)` and friends are not.
      const listLike = /^\(.*\)$/s.test(part) && !/^[A-Za-z]/.test(part);
      for (const id of mentioned) {
        const list = refs.get(id);
        const entry = { statement, position, scalar, listLike };
        if (list) list.push(entry);
        else refs.set(id, [entry]);
      }
    }
  }
  return { byId, refs, nextId };
}

/** The single `#id` in an attribute, or undefined when it is `$` or a list. */
function refAt(statement, position) {
  const part = splitArgs(statement.args)[position];
  if (part === undefined) return undefined;
  const match = /^#(\d+)$/.exec(part.trim());
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Depth-first walk of everything reachable from `roots`, by express id. */
export function reachable(index, roots, limit = 20000) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0 && seen.size < limit) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const statement = index.byId.get(id);
    if (!statement) continue;
    for (const child of referencesIn(statement.args)) {
      if (!seen.has(child)) stack.push(child);
    }
  }
  return seen;
}

/** Entity types whose presence in a representation subgraph makes the element
 *  CURVED — its surface is sampled, not cornered, so two producers of the same
 *  nominal shape emit different triangles. */
const CURVED_TYPES = new Set([
  'IFCCIRCLE',
  'IFCELLIPSE',
  'IFCCIRCLEPROFILEDEF',
  'IFCCIRCLEHOLLOWPROFILEDEF',
  'IFCELLIPSEPROFILEDEF',
  'IFCSWEPTDISKSOLID',
  'IFCREVOLVEDAREASOLID',
  'IFCSURFACEOFREVOLUTION',
  'IFCCYLINDRICALSURFACE',
  'IFCSPHERE',
  'IFCRIGHTCIRCULARCYLINDER',
  'IFCRIGHTCIRCULARCONE',
  'IFCBSPLINECURVEWITHKNOTS',
  'IFCRATIONALBSPLINECURVEWITHKNOTS',
  'IFCBSPLINESURFACEWITHKNOTS',
  'IFCRATIONALBSPLINESURFACEWITHKNOTS',
  'IFCTOROIDALSURFACE',
]);

/**
 * `'curved'` when the element's representation samples a curve or curved
 * surface anywhere, `'prismatic'` when it has a representation made only of
 * corners, `'none'` when it has no representation at all.
 *
 * The third value is not padding. An `IfcProject`, an `IfcBuildingStorey`, an
 * `IfcTypeObject` or a group carries no geometry, so it can only ever be
 * matched on data — and lumping those in with "prismatic" would let the tier
 * they exercise (the 1:1 residue) hide inside the class that the geometry hash
 * carries.
 */
export function geometryClassOf(index, productId) {
  const statement = index.byId.get(productId);
  if (!statement) return 'none';
  const representation = refAt(statement, PRODUCT_REPRESENTATION);
  if (representation === undefined) return 'none';
  for (const id of reachable(index, [representation])) {
    const type = index.byId.get(id)?.type;
    if (type && CURVED_TYPES.has(type)) return 'curved';
  }
  return 'prismatic';
}

/**
 * Can this element be removed (or cloned) without touching anything else?
 *
 * Only when every reference to it sits inside a list. A scalar reference means
 * some other entity is ABOUT this one — `IfcRelVoidsElement` names its host in
 * a scalar slot — and removing the element would leave that entity dangling
 * while cloning it would produce a twin the void never cuts. Both would break
 * the answer key's claim about what changed, so such elements simply take a
 * different role.
 */
export function isListOnlyReferenced(index, id) {
  const list = index.refs.get(id) ?? [];
  return list.every((entry) => !entry.scalar && entry.listLike);
}

/**
 * Types that reference a representation item WITHOUT sharing its geometry:
 * styles and presentation layers. They are not evidence of a second owner.
 *
 * This bit them: in the Duplex fixture every wall's `IfcExtrudedAreaSolid` has
 * two referrers — its shape representation and an `IfcStyledItem` — so a plain
 * "exactly one referrer" rule found zero reshapeable elements in the whole
 * model and the `reshaped` stratum came out empty.
 */
const PRESENTATION_TYPES =
  /^(IFCSTYLEDITEM|IFCSTYLEDREPRESENTATION|IFCPRESENTATIONLAYER\w*|IFCINDEXED\w*MAP)$/;

/** Referrers that could actually be sharing this geometry. */
export function structuralRefCount(index, id) {
  return (index.refs.get(id) ?? []).filter(
    (entry) => !PRESENTATION_TYPES.test(entry.statement.type),
  ).length;
}

/**
 * Is `id` reachable from `rootId` along a chain that NOTHING ELSE references?
 *
 * Walks UP from the node through `refs` — which is exactly the reverse index
 * this needs — and requires a single structural referrer at every step until
 * it arrives at `rootId`. Anything with a second referrer is shared with some
 * other occurrence, and an in-place rewrite of the node would mutate elements
 * the answer key calls untouched.
 *
 * Owning the `IfcProductDefinitionShape` is NOT sufficient on its own, which is
 * what this closes: IFC shares profiles and curves aggressively, so one
 * `IfcCircleProfileDef` or `IfcTrimmedCurve` is routinely referenced from many
 * occurrences' shapes. The element can own its shape outright and still reach a
 * curve half the model is using.
 */
export function isExclusivelyOwnedBy(index, id, rootId, limit = 64) {
  let current = id;
  for (let step = 0; step < limit; step++) {
    if (current === rootId) return true;
    const referrers = (index.refs.get(current) ?? []).filter(
      (entry) => !PRESENTATION_TYPES.test(entry.statement.type),
    );
    if (referrers.length !== 1) return false;
    current = referrers[0].statement.id;
  }
  return false;
}

/**
 * The two roles in a feature relationship (`IfcRelVoidsElement`,
 * `IfcRelProjectsElement`): the FEATURE (an opening, a projection) and its
 * HOST.
 *
 * They are not interchangeable and the fixture treats them differently:
 *
 * - a **feature** may not be mutated at all. Its geometry is subtracted from
 *   (or added to) the host's, so moving an opening RESHAPES the wall — an
 *   element the answer key calls untouched. The first run measured this as a
 *   6% `kindAgreement` loss on `renamed`, and the disagreeing elements were
 *   coverings, slabs and walls: hosts, every one.
 * - a **host** may be reshaped or re-sampled — those change nothing but its own
 *   mesh — but not moved, because its openings are placed relative to the
 *   placement it is moving away from, and not deleted or duplicated, because
 *   the relationship names it in a scalar slot.
 */
export function featureRoles(index) {
  const features = new Set();
  const hosts = new Set();
  for (const statement of index.byId.values()) {
    if (statement.type !== 'IFCRELVOIDSELEMENT' && statement.type !== 'IFCRELPROJECTSELEMENT') {
      continue;
    }
    const parts = splitArgs(statement.args);
    const host = /^#(\d+)$/.exec(String(parts[4] ?? '').trim());
    const feature = /^#(\d+)$/.exec(String(parts[5] ?? '').trim());
    if (host) hosts.add(Number.parseInt(host[1], 10));
    if (feature) features.add(Number.parseInt(feature[1], 10));
  }
  return { features, hosts };
}

/** Live statements only: an edit routed through a reference into an entity
 *  some earlier deletion already dropped would write to a detached object. */
function isLive(index, statement) {
  return index.byId.get(statement.id) === statement;
}

/**
 * Remove `#id` from a list-valued attribute, returning the new attribute text.
 *
 * Throws when the id was not a TOP-LEVEL member of that list. Returning the
 * list unchanged — the previous behaviour — is the worst of both: the element's
 * statement is deleted anyway, so the file keeps a reference to an express id
 * that no longer exists, and the answer key goes on claiming the element was
 * cleanly removed. A dangling reference in the head revision invalidates every
 * number measured over it, so it stops the run.
 */
function pruneFromList(part, id) {
  const inner = part.trim().slice(1, -1);
  const members = splitArgs(inner);
  const kept = members.filter((item) => item.trim() !== `#${id}`);
  if (kept.length === members.length) {
    throw new Error(
      `cannot delete #${id}: it is referenced from within ${part.slice(0, 80)} but is not a ` +
        'top-level member of that list, so removing the entity would leave a dangling reference',
    );
  }
  return `(${kept.join(',')})`;
}

/**
 * Delete an element: drop its statement and prune it out of every list that
 * mentions it. A relationship left with an empty `RelatedObjects` is dropped
 * too — an `IfcRelDefinesByProperties` relating nothing is not a thing the
 * model should claim.
 */
export function deleteElement(file, index, id) {
  const dropped = new Set([id]);
  for (const entry of index.refs.get(id) ?? []) {
    if (!isLive(index, entry.statement)) continue;
    const parts = splitArgs(entry.statement.args);
    parts[entry.position] = pruneFromList(parts[entry.position], id);
    entry.statement.args = parts.join(',');
    if (/^\(\s*\)$/.test(parts[entry.position])) dropped.add(entry.statement.id);
  }
  file.statements = file.statements.filter((statement) => !dropped.has(statement.id));
  for (const gone of dropped) index.byId.delete(gone);
  return dropped;
}

/** Append a statement, keeping the index in step. */
function emit(file, index, type, args) {
  const statement = { id: index.nextId++, type, args, raw: '' };
  file.statements.push(statement);
  index.byId.set(statement.id, statement);
  return statement.id;
}

/**
 * Translate one element by `vector`, in FILE length units, by cloning its
 * placement chain down to the point that moves.
 *
 * Cloning rather than editing in place is the whole trick: `IfcLocalPlacement`,
 * `IfcAxis2Placement3D` and `IfcCartesianPoint` are all routinely shared, and
 * editing the point in place would move every element that happens to sit at
 * the same spot — including elements the key calls untouched.
 */
export function moveElement(file, index, productId, vector) {
  const product = index.byId.get(productId);
  const placementId = refAt(product, PRODUCT_PLACEMENT);
  const placement = placementId === undefined ? undefined : index.byId.get(placementId);
  if (!placement || placement.type !== 'IFCLOCALPLACEMENT') return false;
  const relative = index.byId.get(refAt(placement, 1));
  if (!relative || relative.type !== 'IFCAXIS2PLACEMENT3D') return false;
  const location = index.byId.get(refAt(relative, 0));
  if (!location || location.type !== 'IFCCARTESIANPOINT') return false;

  const coords = splitArgs(location.args[0] === '(' ? location.args.slice(1, -1) : location.args);
  if (coords.length < 3) return false;
  const moved = coords.map((value, axis) => real(Number.parseFloat(value) + (vector[axis] ?? 0)));
  const pointId = emit(file, index, 'IFCCARTESIANPOINT', `(${moved.join(',')})`);
  const axisId = emit(
    file,
    index,
    'IFCAXIS2PLACEMENT3D',
    setArg(relative, 0, `#${pointId}`).args,
  );
  const localId = emit(
    file,
    index,
    'IFCLOCALPLACEMENT',
    setArg(placement, 1, `#${axisId}`).args,
  );
  product.args = setArg(product, PRODUCT_PLACEMENT, `#${localId}`).args;
  return true;
}

/**
 * Scale the extrusion depth of every swept solid the element owns outright.
 *
 * A multi-layer wall is several extrusions of one profile; scaling all of them
 * is one coherent reshape of one element, which is what the answer key claims.
 */
export function reshapeElement(file, index, productId, scale) {
  const solids = exclusiveSolids(index, productId);
  let changed = 0;
  for (const solidId of solids) {
    const solid = index.byId.get(solidId);
    const depth = Number.parseFloat(splitArgs(solid.args)[3]);
    if (!Number.isFinite(depth) || depth === 0) continue;
    solid.args = setArg(solid, 3, real(depth * scale)).args;
    changed++;
  }
  return changed > 0;
}

/**
 * The extruded solids under this element that NOTHING else in the file refers
 * to, and only when the element owns its shape outright.
 *
 * Both conditions guard the same thing. A solid referenced twice, or a shape
 * reached through an `IfcMappedItem` (type geometry, shared by every
 * occurrence of that type), would reshape elements the answer key calls
 * untouched — and those elements would then be scored as false pairs against a
 * key that is simply wrong.
 */
export function exclusiveSolids(index, productId) {
  const product = index.byId.get(productId);
  const shapeId = product === undefined ? undefined : refAt(product, PRODUCT_REPRESENTATION);
  if (shapeId === undefined) return [];
  if (structuralRefCount(index, shapeId) !== 1) return [];
  const solids = [];
  for (const id of reachable(index, [shapeId])) {
    const type = index.byId.get(id)?.type;
    if (type === 'IFCMAPPEDITEM') return [];
    if (type === 'IFCEXTRUDEDAREASOLID' && structuralRefCount(index, id) === 1) solids.push(id);
  }
  return solids;
}

/**
 * Copy an element, optionally renaming it and shifting it.
 *
 * The copy is enrolled in every list that mentions the original — property
 * sets, type, material, spatial containment — because a bare copy with no
 * properties would carry a different data hash and would not be the duplicate
 * the answer key claims it is.
 */
export function cloneElement(file, index, productId, { name, offset } = {}) {
  const source = index.byId.get(productId);
  const cloneId = emit(file, index, source.type, source.args);
  const clone = index.byId.get(cloneId);
  if (name !== undefined) clone.args = setArg(clone, PRODUCT_NAME, quote(name)).args;
  for (const entry of index.refs.get(productId) ?? []) {
    if (entry.scalar || !entry.listLike || !isLive(index, entry.statement)) continue;
    const parts = splitArgs(entry.statement.args);
    parts[entry.position] = `${parts[entry.position].trim().slice(0, -1)},#${cloneId})`;
    entry.statement.args = parts.join(',');
  }
  if (offset) moveElement(file, index, cloneId, offset);
  return cloneId;
}

// ---------------------------------------------------------------------------
// Successor / split / respecified edits (issue #4955).
//
// Each of these is local by the SAME rules as the edits above: the element
// must own the node being written outright (`isExclusivelyOwnedBy` from the
// product's shape down to the profile), shared nodes are cloned rather than
// edited, and every reference to a cloned product sits inside a list. What is
// new is that several of them change the element's DATA on purpose — a
// rename, a property value — because the engine stages they exercise
// (`respecified`, successor claims, split claims) are exactly the ones that
// fire when the data hash no longer agrees.
// ---------------------------------------------------------------------------

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
/** `IfcMappedItem` slots: (MappingSource, MappingTarget). */
const MAPPED_SOURCE = 0;

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

/** Set the element's `Name` (attribute 2 of every `IfcProduct`). */
export function renameElement(index, productId, name) {
  const product = index.byId.get(productId);
  product.args = setArg(product, PRODUCT_NAME, quote(name)).args;
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

/** `IfcShapeRepresentation` slots: (ContextOfItems, RepresentationIdentifier, RepresentationType, Items). */
const REPRESENTATION_IDENTIFIER = 1;
const REPRESENTATION_ITEMS = 3;
/** `IfcRepresentationMap` slots: (MappingOrigin, MappedRepresentation). */
const MAP_REPRESENTATION = 1;

/** Is this shape representation the meshed one? */
function isBodyRepresentation(statement) {
  return (
    statement?.type === 'IFCSHAPEREPRESENTATION' &&
    unquote(splitArgs(statement.args)[REPRESENTATION_IDENTIFIER] ?? '$') === 'Body'
  );
}

/**
 * The `IfcMappedItem`s directly under a product's BODY representations,
 * as `{ itemId, mapId }` rows. Only the body: a `FootPrint` or `Axis`
 * representation may carry a mapped item too, and pointing THAT at a
 * different map changes the file and nothing about the mesh — the same trap
 * the retriangulation mutation documents for arcs.
 */
function bodyMappedItems(index, productId) {
  const product = index.byId.get(productId);
  const shapeId = product === undefined ? undefined : refAt(product, PRODUCT_REPRESENTATION);
  if (shapeId === undefined) return [];
  const shape = index.byId.get(shapeId);
  if (shape?.type !== 'IFCPRODUCTDEFINITIONSHAPE') return [];
  const rows = [];
  for (const representationId of referencesIn(splitArgs(shape.args)[2] ?? '')) {
    const representation = index.byId.get(representationId);
    if (!isBodyRepresentation(representation)) continue;
    for (const itemId of referencesIn(splitArgs(representation.args)[REPRESENTATION_ITEMS] ?? '')) {
      const item = index.byId.get(itemId);
      if (item?.type !== 'IFCMAPPEDITEM') continue;
      const mapId = refAt(item, MAPPED_SOURCE);
      if (mapId !== undefined) rows.push({ itemId, mapId });
    }
  }
  return rows;
}

/**
 * The one `IfcMappedItem` this element's body owns outright, and the
 * `IfcRepresentationMap` it points at; undefined when the body is not a
 * single owned mapped item.
 *
 * Ownership is of the MAPPED ITEM, not of the map: the map is type geometry
 * shared by every occurrence and is never written. What `swapMappedItem`
 * rewrites is the one pointer from this occurrence's own item to a map.
 */
export function ownedMappedItem(index, productId) {
  const product = index.byId.get(productId);
  const shapeId = product === undefined ? undefined : refAt(product, PRODUCT_REPRESENTATION);
  if (shapeId === undefined || structuralRefCount(index, shapeId) !== 1) return undefined;
  const items = bodyMappedItems(index, productId);
  if (items.length !== 1) return undefined;
  const { itemId, mapId } = items[0];
  if (!isExclusivelyOwnedBy(index, itemId, productId)) return undefined;
  const map = index.byId.get(mapId);
  if (map?.type !== 'IFCREPRESENTATIONMAP') return undefined;
  if (!isBodyRepresentation(index.byId.get(refAt(map, MAP_REPRESENTATION)))) return undefined;
  return { itemId, mapId };
}

/** Every body `IfcRepresentationMap` a product reaches. */
export function representationMapsOf(index, productId) {
  return bodyMappedItems(index, productId).map((row) => row.mapId);
}

/**
 * A structural digest of everything under a representation map: entity types
 * and literal arguments in depth-first order, with references replaced by
 * their visit order. Two maps that are byte-for-byte copies of one geometry
 * — ArchiCAD writes one `IfcRepresentationMap` per window and several of
 * them identical — digest equal, and a `swapped` element pointed at such a
 * copy would keep its world geometry hash and be paired as `respecified`,
 * which the key would then call wrong. The digest is the base-side fact that
 * rules those donors out; no hash of the head is consulted.
 */
export function representationMapDigest(index, mapId) {
  const order = new Map();
  const lines = [];
  const visit = (id) => {
    if (order.has(id)) return;
    order.set(id, order.size);
    const statement = index.byId.get(id);
    if (!statement) return;
    const children = referencesIn(statement.args);
    for (const child of children) visit(child);
    const map = new Map(children.map((child) => [child, order.get(child) ?? -1]));
    lines.push(`${statement.type}(${rewriteReferences(statement.args, map)})`);
  };
  visit(mapId);
  return lines.join('\n');
}

/** Point the element's owned mapped item at `donorMapId`. */
export function swapMappedItem(index, productId, donorMapId) {
  const owned = ownedMappedItem(index, productId);
  if (!owned || owned.mapId === donorMapId) return false;
  const item = index.byId.get(owned.itemId);
  item.args = setArg(item, MAPPED_SOURCE, `#${donorMapId}`).args;
  return true;
}

/**
 * The property-set values this element owns outright: each is an
 * `IfcPropertySingleValue` reachable through an `IfcRelDefinesByProperties`
 * that relates THIS element alone, a set nothing else references, and a
 * property nothing else references. IFC shares property sets and even single
 * properties across occurrences, and editing a shared one would respecify
 * elements the key calls untouched.
 *
 * Returns `{ propertyId, name }` rows, in file order.
 */
export function ownedPropertyValues(index, productId) {
  const rows = [];
  for (const entry of index.refs.get(productId) ?? []) {
    const rel = entry.statement;
    if (rel.type !== 'IFCRELDEFINESBYPROPERTIES' || !isLive(index, rel)) continue;
    const parts = splitArgs(rel.args);
    // (GlobalId, OwnerHistory, Name, Description, RelatedObjects, RelatingPropertyDefinition)
    const related = referencesIn(parts[4] ?? '');
    if (related.length !== 1 || related[0] !== productId) continue;
    const setId = refAt(rel, 5);
    const set = setId === undefined ? undefined : index.byId.get(setId);
    if (set?.type !== 'IFCPROPERTYSET' || structuralRefCount(index, setId) !== 1) continue;
    // (GlobalId, OwnerHistory, Name, Description, HasProperties)
    for (const propertyId of referencesIn(splitArgs(set.args)[4] ?? '')) {
      const property = index.byId.get(propertyId);
      if (property?.type !== 'IFCPROPERTYSINGLEVALUE') continue;
      if (structuralRefCount(index, propertyId) !== 1) continue;
      const value = splitArgs(property.args)[2];
      // A typed literal only — `IFCLABEL('x')`, `IFCREAL(1.)`, `IFCBOOLEAN(.T.)`.
      // Editing an enumeration or a reference would be a schema question.
      if (!/^(IFC[A-Z]+)\((.+)\)$/s.test(value ?? '')) continue;
      rows.push({ propertyId, name: unquote(splitArgs(property.args)[0] ?? '$') });
    }
  }
  return rows;
}

/**
 * Change ONE owned property value, keeping its type and its name. A label
 * gets a suffix, a number is scaled, a logical is flipped — the property NAME
 * multiset the harness asserts identical between revisions is untouched.
 */
export function respecifyProperty(index, propertyId) {
  const property = index.byId.get(propertyId);
  const parts = splitArgs(property.args);
  const typed = /^(IFC[A-Z]+)\((.+)\)$/s.exec(parts[2]);
  if (!typed) return false;
  const [, type, literal] = typed;
  let next;
  if (/^'.*'$/s.test(literal)) next = quote(`${unquote(literal)} (rev B)`);
  else if (/^\.(T|F)\.$/.test(literal)) next = literal === '.T.' ? '.F.' : '.T.';
  else if (/^-?\d+\.?\d*(E[-+]?\d+)?$/i.test(literal)) {
    const number = Number.parseFloat(literal);
    if (!Number.isFinite(number)) return false;
    const scaled = number === 0 ? 1 : number * 1.5;
    next = /[.E]/i.test(literal) ? real(scaled) : String(Math.round(scaled));
  } else return false;
  parts[2] = `${type}(${next})`;
  property.args = parts.join(',');
  return true;
}
