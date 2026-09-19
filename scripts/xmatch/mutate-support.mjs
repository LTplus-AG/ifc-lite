/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small tools `mutate.mjs` is built from: the seeded PRNG, the schema
 * predicates, the re-GUID and express-id permutation, and the placement
 * helpers. Split out of `mutate.mjs` for size; nothing here decides WHAT is
 * mutated, and the scorecard is byte-identical to before the split.
 */

import { getInheritanceChainAcrossSchemas } from '../../packages/parser/dist/index.js';
import { generateIfcGuid } from '../../packages/encoding/dist/index.js';
import { PRODUCT_PLACEMENT } from './edits.mjs';
import { quote, rewriteReferences, setArg, splitArgs } from './step-file.mjs';

/** Deterministic 32-bit PRNG (mulberry32): same seed, same model, same file. */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, random) {
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
export function isRootType(type) {
  const cached = rootTypes.get(type);
  if (cached !== undefined) return cached;
  const chain = getInheritanceChainAcrossSchemas(type);
  const isRoot = chain.includes('IfcRoot');
  rootTypes.set(type, isRoot);
  return isRoot;
}

/** Does this STEP type inherit from `IfcSpatialElement` (IFC4) or
 *  `IfcSpatialStructureElement` (IFC2X3) in any bundled schema? */
const spatialTypes = new Map();
export function isSpatialType(type) {
  const cached = spatialTypes.get(type);
  if (cached !== undefined) return cached;
  const chain = getInheritanceChainAcrossSchemas(type);
  const spatial = chain.includes('IfcSpatialElement') || chain.includes('IfcSpatialStructureElement');
  spatialTypes.set(type, spatial);
  return spatial;
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
export function permuted(permutation, id) {
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
export function axisVector(ordinal, length) {
  const axis = ordinal % 3;
  const vector = [0, 0, 0];
  vector[axis] = ordinal % 2 === 0 ? length : -length;
  return vector;
}

export function hasOwnPlacement(index, id) {
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
export function reguidAll(file, random) {
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
export function permuteIds(file, random) {
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

/**
 * Assign up to `count` whole same-content groups to the `movedGroup` role —
 * moved out of `mutate.mjs` for the module-size house rule (AGENTS.md).
 * Skips a group with fewer than 3 eligible members: tier 3's mutual-nearest
 * pairing needs a genuine N:N residue, and 2 members moved apart is
 * indistinguishable from two ordinary `moved` elements.
 */
export function assignGroups(groups, count, eligible, taken, roles) {
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
 * Draw `splitLength` and `merged` (issue #4989) from the SAME pool — a
 * detached rectangle owner — interleaved (split, merge, split, merge, …)
 * rather than one drained before the other starts. Moved out of
 * `mutate.mjs` for the module-size house rule; the caller has the full
 * story on why interleaving matters (review finding, 2026-09-19: draining
 * one role first was measured to starve whichever population floor the
 * corpus runs out of candidates for first).
 *
 * Mutates `taken` and `roles` in place, like `assign`/`assignGroups`
 * elsewhere in this file. Reports (stderr, never throws) when the pool
 * cannot supply both floors — a fixture-shape question, not something to
 * paper over by silently lowering either count.
 */
export function interleaveSplitAndMerge(pool, taken, roles, eligible, plan, sourcePath) {
  const candidates = pool.filter(eligible);
  let splitCount = 0;
  let mergedCount = 0;
  let turn = 'splitLength';
  for (const id of candidates) {
    if (taken.has(id)) continue;
    if (splitCount >= plan.splitLength && mergedCount >= plan.merged) break;
    let role = turn;
    if (role === 'splitLength' && splitCount >= plan.splitLength) role = 'merged';
    else if (role === 'merged' && mergedCount >= plan.merged) role = 'splitLength';
    if (role === 'splitLength' && splitCount >= plan.splitLength) continue;
    if (role === 'merged' && mergedCount >= plan.merged) continue;
    taken.add(id);
    roles.set(id, role);
    if (role === 'splitLength') splitCount++;
    else mergedCount++;
    turn = role === 'splitLength' ? 'merged' : 'splitLength';
  }
  if (candidates.length < plan.splitLength + plan.merged) {
    process.stderr.write(
      `xmatch: ${sourcePath || 'model'}: detached-rectangle pool is ${candidates.length}, ` +
        `short of splitLength ${plan.splitLength} + merged ${plan.merged} = ${plan.splitLength + plan.merged}\n`,
    );
  }
}

/** The declared mutation set `mutate.mjs` draws from. Counts are targets; a
 *  role that cannot be applied to a given element falls through to the next
 *  candidate, and the answer key records what was actually applied. Moved
 *  out of `mutate.mjs` for the module-size house rule (AGENTS.md). */
export const DEFAULT_PLAN = {
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
  /** The base-side split-in-reverse (issue #4989) — the honest inverse of
   *  `splitLength`, drawn AFTER it (interleaved, `interleaveSplitAndMerge`)
   *  from the same detached-rectangle-owner pool. */
  merged: 8,
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
