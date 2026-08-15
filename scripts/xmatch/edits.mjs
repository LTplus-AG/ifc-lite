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
  setArg,
  splitArgs,
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
