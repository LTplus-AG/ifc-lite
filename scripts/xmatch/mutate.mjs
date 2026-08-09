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
import { getInheritanceChainAcrossSchemas } from '../../packages/parser/dist/index.js';
// The repository's OWN seeded GlobalId generator, not a hand-rolled one.
// A 22-character IFC GlobalId is a base64 encoding of a 128-bit UUID, so its
// FIRST character carries only two bits and must be `0`-`3`; drawing it from
// the full 64-character alphabet, as this file first did, makes 15 of every 16
// identifiers unrepresentable — they may be rejected outright, or decode and
// re-encode to a DIFFERENT string, which in a fixture whose premise is "this
// is what a plausible re-export looks like" would eventually surface as a
// matcher bug. `generateIfcGuid` goes through `uuidToIfcGuid`, so the
// constraint is enforced by construction rather than by remembering it here.
import { generateIfcGuid } from '../../packages/encoding/dist/index.js';
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
  PRODUCT_PLACEMENT,
} from './edits.mjs';
import { planeAngleFactor, resampleableArcs, retriangulateElement } from './retriangulate.mjs';
import { parseStepFile, quote, rewriteReferences, serializeStepFile, setArg, splitArgs } from './step-file.mjs';

/** Deterministic 32-bit PRNG (mulberry32): same seed, same model, same file. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Does this STEP type inherit from `IfcRoot` in ANY bundled schema? Decided
 *  from the registry, never from what attribute 0 happens to look like. */
const rootTypes = new Map();
function isRootType(type) {
  const cached = rootTypes.get(type);
  if (cached !== undefined) return cached;
  const chain = getInheritanceChainAcrossSchemas(type);
  const isRoot = chain.includes('IfcRoot');
  rootTypes.set(type, isRoot);
  return isRoot;
}

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
  /** Extrusion depth multiplier for `reshaped`. */
  reshapeScale: 1.15,
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
  assign('retriangulated', plan.retriangulated, selfContained((id) => resampleableArcs(index, id).length > 0));
  assign('reshaped', plan.reshaped, selfContained((id) => exclusiveSolids(index, id).length > 0));
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
  const insertionSources = pool
    .filter((id) => !taken.has(id) && detached(() => true)(id))
    .slice(0, plan.inserted);
  for (const id of population) if (!roles.has(id)) roles.set(id, 'renamed');

  /** @type {{ base: number, kind: string, class: string, head: number[], detail?: object }[]} */
  const entries = [];
  const insertedHeadIds = [];
  const applied = { renamed: 0, moved: 0, reshaped: 0, retriangulated: 0, duplicated: 0, deleted: 0, inserted: 0 };
  let moveIndex = 0;

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
    keyVersion: 1,
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
    })),
    insertedHeadIds: insertedHeadIds.map((id) => permuted(permutation, id)),
  };

  return { text: serializeStepFile(file), key };
}

/**
 * Assign every eligible member of the first `count` same-content groups to the
 * `movedGroup` role, returning each member's ordinal within its group.
 */
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

/**
 * The permuted id, or a thrown error.
 *
 * Silently DROPPING an unmapped head id was the dangerous version: the key
 * would still be well-formed, the run would still score, and the element would
 * simply have fewer counterparts than the mutation program actually created —
 * a quietly wrong answer key producing a confidently wrong number. Every id in
 * `entries` came out of `file.statements`, and `permuteIds` maps every
 * statement, so a miss here is an invariant break in this file and must stop
 * the run rather than be tidied away.
 */
function permuted(permutation, id) {
  const mapped = permutation.get(id);
  if (mapped === undefined) {
    throw new Error(
      `answer key corrupt: express id ${id} has no permutation entry, so the head ` +
        'revision does not contain the element the key describes',
    );
  }
  return mapped;
}

/** A translation along a rotating axis so the moves are not all collinear. */
function axisVector(ordinal, length) {
  const axis = ordinal % 3;
  const vector = [0, 0, 0];
  vector[axis] = ordinal % 2 === 0 ? length : -length;
  return vector;
}

function hasOwnPlacement(index, id) {
  const statement = index.byId.get(id);
  const part = splitArgs(statement.args)[PRODUCT_PLACEMENT];
  if (!/^#\d+$/.test(String(part).trim())) return false;
  const placement = index.byId.get(Number.parseInt(String(part).trim().slice(1), 10));
  return placement?.type === 'IFCLOCALPLACEMENT';
}

/**
 * Give every `IfcRoot` a new GlobalId — attribute 0, by parsed position.
 *
 * This is the anchored rewrite: membership comes from the schema registry and
 * the slot is an attribute index, so a 22-character property-set NAME is never
 * even a candidate.
 */
function reguidAll(file, random) {
  let rewritten = 0;
  for (const statement of file.statements) {
    if (!isRootType(statement.type)) continue;
    statement.args = setArg(statement, 0, quote(generateIfcGuid(random))).args;
    rewritten++;
  }
  return rewritten;
}

/**
 * Permute every express id.
 *
 * Without this, base and head express ids would coincide for untouched
 * elements, and the harness — or a future reader of it — could correlate the
 * two files without going through the answer key at all. The whole point of
 * the key is that it is the ONLY channel linking the revisions, so the obvious
 * accidental channel is closed by construction.
 */
function permuteIds(file, random) {
  const ids = file.statements.map((statement) => statement.id);
  const targets = shuffled(ids, random);
  const map = new Map(ids.map((id, position) => [id, targets[position]]));
  for (const statement of file.statements) {
    statement.args = rewriteReferences(statement.args, map);
    statement.id = map.get(statement.id);
  }
  file.statements.sort((a, b) => a.id - b.id);
  return map;
}
