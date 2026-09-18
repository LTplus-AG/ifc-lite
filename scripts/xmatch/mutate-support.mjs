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
