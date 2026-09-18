/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The answer key's source of truth: a seeded, declared mutation of a real model.
 *
 * Given a model from `tests/models/` and a seed, this produces a head revision
 * and the TRUE correspondence between the two — keyed by **source express id**,
 * a channel the matcher never sees. The key is produced by CONSTRUCTION (the
 * generator writes down what it did) rather than by any hash, comparison or
 * heuristic, which is what makes it an answer key rather than a second opinion.
 *
 * The head is a from-scratch re-export of the sort the content matcher exists
 * for: every `IfcRoot` gets a new GlobalId, and every express id is permuted,
 * so no line, id or key survives to correlate the two files by accident.
 *
 * ## The re-GUID trap this file is built around
 *
 * A naive re-GUID rewrites "every 22-character quoted token". That also renames
 * `Qto_WallBaseQuantities` and `SpaceTemperatureSummer` — both exactly 22
 * characters in the IFC base64 alphabet — which changes property *names*, moves
 * every data hash, and makes the matcher look broken when the fixture is. Here
 * the rewrite is anchored to **attribute 0 of statements whose type inherits
 * from `IfcRoot`**, decided from the bundled schema registry. `run.mjs` then
 * asserts the property- and quantity-set name multisets are identical between
 * base and head, so a regression in this file surfaces as a failed guard rather
 * than as a mysterious 0% recall.
 */

import { createHash } from 'node:crypto';
// Relative, like `fingerprints.mjs`: the workspace root links no packages.
// The repository's OWN seeded GlobalId generator, not a hand-rolled one.
// A 22-character IFC GlobalId is a base64 encoding of a 128-bit UUID, so its
// FIRST character carries only two bits and must be `0`-`3`; drawing it from
// the full 64-character alphabet, as this file first did, makes 15 of every 16
// identifiers unrepresentable — they may be rejected outright, or decode and
// re-encode to a DIFFERENT string, which in a fixture whose premise is "this
// is what a plausible re-export looks like" would eventually surface as a
// matcher bug. `generateIfcGuid` goes through `uuidToIfcGuid`, so the
// constraint is enforced by construction rather than by remembering it here.
import {
  cloneElement,
  deleteElement,
  featureRoles,
  geometryClassOf,
  indexModel,
  isListOnlyReferenced,
  moveElement,
  reshapeElement,
  exclusiveSolids,
} from './edits.mjs';
import { ownedRectangleExtrusion } from './rectangle-edits.mjs';
import { applySuccessorRole, mapDonors } from './successor-mutations.mjs';
import {
  axisVector,
  hasOwnPlacement,
  isSpatialType,
  permuteIds,
  permuted,
  reguidAll,
  rng,
  shuffled,
} from './mutate-support.mjs';
// The SHIPPED class-family table (issue #4955), imported from the engine's own
// module rather than copied: `swapped` picks its donor map from an element of
// the same family because that is the bucket the successor stage searches, and
// a private copy of the table would drift from the thing being measured.
import { planeAngleFactor, resampleableArcs, retriangulateElement } from './retriangulate.mjs';
import { parseStepFile, serializeStepFile } from './step-file.mjs';

/** The declared mutation set. Counts are targets; a role that cannot be
 *  applied to a given element falls through to the next candidate, and the
 *  answer key records what was actually applied. */
const DEFAULT_PLAN = {
  retriangulated: 12,
  reshaped: 18,
  deleted: 12,
  duplicated: 8,
  moved: 24,
  /** Whole same-content groups moved at once — the only path to tier 3. */
  movedGroups: 2,
  inserted: 8,
  /** Re-GUID plus ONE data edit and no geometry change (issue #4955). */
  respecified: 14,
  /** Rename plus a 1.25x thickness: the `footprint` successor case. */
  thickened: 10,
  /** Rename plus a different type's mapped geometry: the `position` case. */
  swapped: 6,
  /** One owned rectangle extrusion becomes two half-length products. */
  splitLength: 6,
  /** Of the `deleted`, how many get a small head-only element planted inside
   *  their box — the successor stage's negative control. */
  insertedNearby: 5,
  /** Extrusion depth multiplier for `reshaped`. */
  reshapeScale: 1.15,
  /** Thickness multiplier for `thickened`: old box nests in new, IoU 0.8. */
  thickenScale: 1.25,
  /** Per-axis size of the `insertedNearby` element relative to the deleted one. */
  nearbyFactor: 0.3,
  /** Move distances (metres) cycled through for `moved`, all well inside the
   *  engine's 10 m `maxMoveDistance` and well outside its 2 mm move tolerance. */
  moveDistances: [0.35, 0.8, 1.6, 2.4],
};

/**
 * Mutate `text` into a head revision plus the answer key.
 *
 * @param text      source STEP text
 * @param options   `{ seed, meshedIds, unitScale, plan, sourcePath }`
 *                  `meshedIds` is the set of express ids the geometry pass
 *                  produced a mesh for — the population the viewer's compare
 *                  adapter fingerprints, and therefore the only population a
 *                  content match can be scored over.
 */
export function mutateModel(text, options) {
  const { seed, meshedIds, population: keyed, unitScale = 1, sourcePath = '' } = options;
  const plan = { ...DEFAULT_PLAN, ...(options.plan ?? {}) };
  const random = rng(seed);
  const file = parseStepFile(text);
  const index = indexModel(file);
  const angleFactor = planeAngleFactor(file);

  // KEYED population: every entity the fingerprint adapter compares, so the
  // scoring denominator covers the whole comparison and not just the part that
  // was mutated. MESHED subset: the only elements a geometry mutation may be
  // applied to — moving an `IfcSite`'s placement would drag the entire model
  // with it and silently invalidate every other row of the key.
  const population = [...keyed].filter((id) => index.byId.has(id)).sort((a, b) => a - b);
  const meshed = new Set([...meshedIds].filter((id) => index.byId.has(id)));
  const classes = new Map(population.map((id) => [id, geometryClassOf(index, id)]));

  const pool = shuffled(population, random);
  const taken = new Set();
  const roles = new Map();
  /** Take up to `count` elements from the pool that pass `eligible`. */
  const assign = (role, count, eligible) => {
    let assigned = 0;
    for (const id of pool) {
      if (assigned >= count) break;
      if (taken.has(id) || !eligible(id)) continue;
      taken.add(id);
      roles.set(id, role);
      assigned++;
    }
    return assigned;
  };

  // Order matters: the most constrained pools pick first, so a role with few
  // eligible elements is not starved by one that could have used anything.
  //
  // `isListOnlyReferenced` gates EVERY geometry mutation, not just the
  // destructive ones. An element some other entity names in a scalar slot is
  // entangled with it: an `IfcOpeningElement` and the wall it voids reference
  // each other through `IfcRelVoidsElement`, so moving the opening reshapes the
  // WALL — an element the answer key calls untouched. The first run of this
  // fixture measured that as a 6% `kindAgreement` loss on `renamed`, with the
  // disagreeing elements all coverings, slabs and walls: hosts, every one.
  const { features, hosts } = featureRoles(index);
  // Self-contained edits: a host may be reshaped or re-sampled (only its own
  // mesh moves), so those roles exclude features alone.
  const selfContained = (test) => (id) => meshed.has(id) && !features.has(id) && test(id);
  // Detached edits: nothing else in the file may name the element in a scalar
  // slot, and it may not be a host either — its openings are placed relative to
  // the placement it would be moving away from.
  const detached = (test) => (id) =>
    meshed.has(id) && !features.has(id) && !hosts.has(id) && isListOnlyReferenced(index, id) && test(id);
  // The split and the nearby control need the rarest thing in the corpus: a
  // detached element that owns one extruded rectangle outright. They pick
  // first so the broader roles cannot starve them.
  // No #4955 role on a SPATIAL element. Each of them renames (or, for the
  // nearby control, clones under a new name), and a space's Name is part of
  // the container path of everything inside it — renaming one moves the
  // path of neighbours the key calls untouched. Decided from the registry.
  const spatial = (id) => isSpatialType(index.byId.get(id).type);
  const ownsRectangle = (id) => !spatial(id) && ownedRectangleExtrusion(index, id) !== undefined;
  assign('splitLength', plan.splitLength, detached(ownsRectangle));
  assign('deletedNearby', plan.insertedNearby, detached(ownsRectangle));
  assign('retriangulated', plan.retriangulated, selfContained((id) => resampleableArcs(index, id).length > 0));
  // A thickened host only changes its own mesh, like `reshaped`; it picks
  // before `reshaped`, whose eligible set is a superset of this one.
  assign('thickened', plan.thickened, selfContained(ownsRectangle));
  assign('reshaped', plan.reshaped, selfContained((id) => exclusiveSolids(index, id).length > 0));
  const donors = mapDonors(index, population);
  assign('swapped', plan.swapped, selfContained((id) => !spatial(id) && donors.has(id)));
  assign('deleted', plan.deleted, detached(() => true));
  assign('duplicated', plan.duplicated, detached(() => true));
  // Whole same-content groups, moved member by member to DIFFERENT places.
  // This is the only construction that reaches the positional tier: tier 1
  // sub-buckets each moved member into its own world-hash bucket, the 1:1
  // residue rule does not apply to an N:N leftover, and what is left is
  // exactly the mutual-nearest-neighbour problem tier 3 exists for. Without
  // it that tier stays dark and the fixture would report a tier score for a
  // tier that never fired.
  const groupMoved = assignGroups(
    options.sameContentGroups ?? [],
    plan.movedGroups,
    detached((id) => hasOwnPlacement(index, id)),
    taken,
    roles,
  );
  assign('moved', plan.moved, detached((id) => hasOwnPlacement(index, id)));
  // Last, and excluding HOSTS as well as features: a respecified element is
  // recovered by its world geometry hash alone, and finding F1 (SPEC.md) is
  // that a host's hash can move with statement order through the opening
  // CSG. A hash that moved for a reason unrelated to the mutation would score
  // the engine against a key that promised an unchanged shape.
  assign('respecified', plan.respecified, selfContained((id) => !hosts.has(id) && !spatial(id)));
  const insertionSources = pool
    .filter((id) => !taken.has(id) && detached(() => true)(id))
    .slice(0, plan.inserted);
  for (const id of population) if (!roles.has(id)) roles.set(id, 'renamed');

  /** @type {{ base: number, kind: string, class: string, head: number[], detail?: object }[]} */
  const entries = [];
  const insertedHeadIds = [];
  const insertedNearbyHeadIds = [];
  const applied = {
    renamed: 0,
    moved: 0,
    reshaped: 0,
    retriangulated: 0,
    duplicated: 0,
    deleted: 0,
    inserted: 0,
    respecified: 0,
    thickened: 0,
    swapped: 0,
    splitLength: 0,
    insertedNearby: 0,
  };
  let moveIndex = 0;
  const ordinals = {};
  /** A name nothing in the base carries: `${kind}-${seed}-${n}`. */
  const freshName = (kind) => `${kind}-${seed}-${(ordinals[kind] = (ordinals[kind] ?? 0) + 1)}`;
  const successorContext = { file, index, plan, freshName, donors, entries, applied, insertedNearbyHeadIds };

  for (const id of population) {
    const role = roles.get(id);
    const geometryClass = classes.get(id);
    if (role === 'movedGroup') {
      const ordinal = groupMoved.get(id) ?? 0;
      // Distinct magnitudes per member so no base sits equidistant between two
      // heads: mutual nearest neighbour abstains on ties by design, and a tie
      // here would be the fixture's doing, not the engine's.
      const distance = 0.25 + 0.35 * ordinal;
      const ok = moveElement(file, index, id, axisVector(ordinal + 1, distance / unitScale));
      entries.push({
        base: id,
        kind: ok ? 'moved' : 'renamed',
        class: geometryClass,
        head: [id],
        detail: ok ? { distanceMetres: distance, group: true } : undefined,
      });
      applied[ok ? 'moved' : 'renamed']++;
    } else if (role === 'moved') {
      const distance = plan.moveDistances[moveIndex++ % plan.moveDistances.length];
      // The vector is expressed in FILE units; the world displacement is its
      // length times the unit scale, invariant under the placement chain's
      // rotations (placements are rigid).
      const vector = axisVector(moveIndex, distance / unitScale);
      const ok = moveElement(file, index, id, vector);
      entries.push({
        base: id,
        kind: ok ? 'moved' : 'renamed',
        class: geometryClass,
        head: [id],
        detail: ok ? { distanceMetres: distance } : undefined,
      });
      applied[ok ? 'moved' : 'renamed']++;
    } else if (role === 'reshaped') {
      const ok = reshapeElement(file, index, id, plan.reshapeScale);
      entries.push({ base: id, kind: ok ? 'reshaped' : 'renamed', class: geometryClass, head: [id] });
      applied[ok ? 'reshaped' : 'renamed']++;
    } else if (role === 'retriangulated') {
      const arcs = retriangulateElement(file, index, id, angleFactor);
      entries.push({
        base: id,
        kind: arcs > 0 ? 'retriangulated' : 'renamed',
        class: geometryClass,
        head: [id],
        detail: arcs > 0 ? { arcs, stepDegrees: 7.3 } : undefined,
      });
      applied[arcs > 0 ? 'retriangulated' : 'renamed']++;
    } else if (role === 'duplicated') {
      const copy = cloneElement(file, index, id);
      entries.push({ base: id, kind: 'duplicated', class: geometryClass, head: [id, copy] });
      applied.duplicated++;
    } else if (role === 'deleted') {
      deleteElement(file, index, id);
      entries.push({ base: id, kind: 'deleted', class: geometryClass, head: [] });
      applied.deleted++;
    } else if (applySuccessorRole(successorContext, role, id, geometryClass)) {
      // A #4955 role (deletedNearby / respecified / thickened / swapped /
      // splitLength), applied in successor-mutations.mjs.
    } else {
      entries.push({ base: id, kind: 'renamed', class: geometryClass, head: [id] });
      applied.renamed++;
    }
  }

  for (const [ordinal, id] of insertionSources.entries()) {
    // A genuinely new element: same shape, but a name nothing in the base
    // carries, so its data hash is new and no bucket can legitimately hold it
    // together with any base entity.
    const copy = cloneElement(file, index, id, {
      name: `xmatch-inserted-${seed}-${ordinal}`,
      offset: axisVector(ordinal + 1, 5 / unitScale),
    });
    insertedHeadIds.push(copy);
    applied.inserted++;
  }

  const guids = reguidAll(file, random);
  const permutation = permuteIds(file, random);

  const key = {
    generator: 'scripts/xmatch/mutate.mjs',
    // 2: `respecified` / `thickened` / `swapped` / `splitLength` kinds and
    // `insertedNearbyHeadIds` (issue #4955).
    keyVersion: 2,
    seed,
    source: sourcePath,
    sourceSha256: createHash('sha256').update(text).digest('hex'),
    unitScale,
    plan,
    applied,
    population: population.length,
    guidsRewritten: guids,
    elements: entries.map((entry) => ({
      ...entry,
      head: entry.head.map((id) => permuted(permutation, id)),
      ...(entry.detail?.insertedNearby !== undefined
        ? { detail: { ...entry.detail, insertedNearby: permuted(permutation, entry.detail.insertedNearby) } }
        : {}),
    })),
    insertedHeadIds: insertedHeadIds.map((id) => permuted(permutation, id)),
    insertedNearbyHeadIds: insertedNearbyHeadIds.map((id) => permuted(permutation, id)),
  };

  return { text: serializeStepFile(file), key };
}

function assignGroups(groups, count, eligible, taken, roles) {
  const ordinals = new Map();
  let used = 0;
  for (const group of groups) {
    if (used >= count) break;
    const members = group.filter((id) => !taken.has(id) && eligible(id));
    if (members.length < 3) continue;
    for (const [ordinal, id] of members.entries()) {
      taken.add(id);
      roles.set(id, 'movedGroup');
      ordinals.set(id, ordinal);
    }
    used++;
  }
  return ordinals;
}
