/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 step 4: the null-space audit.
 *
 * Split out of run.mjs for the house size rule. Enumerates what the scored
 * observable is invariant under and adds one check that is not, then asserts
 * -- through run.mjs's assertion path -- that the two disagree.
 */

import { createHash } from 'node:crypto';

import { loadProvenance } from './replay.mjs';


/**
 * What is the scored observable INVARIANT under, and is there a check that is
 * not?
 *
 * THE OBSERVABLE. Ground truth in this battery is `canonicalStateBytes`, and
 * that function serializes exactly: the storey vocabulary, and per entity its
 * node id, key, ifcType, storeyId, hostId, property sets and meshes. The
 * observable is therefore blind to every part of the model that is not one of
 * those, and two orders that differ only outside that list are scored as
 * having commuted.
 *
 * THE FIRST CANDIDATE WAS WRONG, AND THAT IS RECORDED HERE RATHER THAN
 * QUIETLY DROPPED. This audit was written expecting the hosting relation to be
 * in the null space, on the reasoning that footprint.ts excludes
 * relationship-kind ancestors. It is not: B4.2 added `hostId` to the canonical
 * bytes, with a comment saying why. So the hosting hazard IS visible to the
 * oracle and the null space is somewhere else. The rest of this function is
 * what was found after that correction.
 *
 * WHERE IT ACTUALLY IS. `ModelState` carries exactly one relationship, the
 * host-to-opening link. Spatial containment is carried as a STRING on the
 * entity, and the relationship node that aggregates a storey's elements exists
 * only in the DAG, never in the state. Nothing in the op vocabulary writes it.
 * So the observable is invariant under every edit to spatial-structure
 * membership, and the generator cannot produce one -- which means the entire
 * battery, at every schedule count and every seed, contains zero instances of
 * the one op class footprint.ts's own docstring names as out of scope:
 *
 *   "an EditOp whose targetNodeIds names a relationship/layer node DIRECTLY
 *   ... is added to writtenNodes as a target, but a concurrent edit to one of
 *   that storey's elements will NOT see it, because the element-edit's own
 *   ancestor walk excludes the storey node ... if a future op kind targets
 *   containers directly, this rule needs revisiting."
 *
 * That is a soundness caveat the shipped code states about itself, and the
 * exam that is supposed to adjudicate the predicate is invariant under it. It
 * is the same shape as an exam that cannot see a wall placed below its room:
 * not a wrong answer, an unasked question.
 *
 * THE CHECK THAT IS NOT INVARIANT. Below, the op vocabulary is extended by one
 * kind -- setting a storey's membership list, which is an ordinary edit to
 * `IfcRelContainedInSpatialStructure.RelatedElements` and which the
 * collaboration layer already has a conflict kind for -- and the SHIPPED
 * predicate is asked about it. The verdict is asserted positively: the
 * predicate must clear the pair AND the two orders must diverge. That
 * combination is an unsound auto-merge, on an op the product supports and the
 * battery cannot generate.
 */
function storeyNodeIdOf(storeyId) {
  // Mirrors merge-model.ts's own storeyNodeId, which is module-private.
  return `storey-rel:${storeyId}`;
}

/** The membership list the DAG's storey relationship aggregates, lifted out of
 *  the entity records so it can be edited as its own thing -- which is what it
 *  is in IFC and what it is not in this op model. */
function membershipOf(state) {
  const m = new Map();
  for (const s of state.storeyIds) m.set(s, []);
  for (const [id, e] of state.entities) {
    if (!m.has(e.storeyId)) m.set(e.storeyId, []);
    m.get(e.storeyId).push(id);
  }
  for (const list of m.values()) list.sort();
  return m;
}

function membershipDigest(m) {
  const rows = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, ids]) => `${s}=${ids.join(',')}`);
  return createHash('sha256').update(rows.join('|')).digest('hex').slice(0, 16);
}

/** Apply an extended op. The four shipped kinds go to the shipped applier, so
 *  no shipped semantics are reimplemented here. */
function applyExtended(P, world, op, semantics) {
  if (op.type === 'storey-set-members') {
    const membership = new Map(world.membership);
    membership.set(op.storeyId, [...op.members].sort());
    return { state: world.state, membership };
  }
  const state = P.applyOps(world.state, [op], semantics);
  return { state, membership: membershipOf(state) };
}

export async function nullSpaceAudit(repoRoot) {
  const P = await loadProvenance(repoRoot);
  const { buildBaseModel, mulberry32, buildStateDag, computeFootprint, computeMergeOpFootprint, conflictPredicate, canonicalStateBytes, DEFAULT_EPSILON_MM } = P;
  const semantics = { cuts: 'derived', containment: 'off' };

  const base = buildBaseModel(mulberry32(20260802));
  const storeyId = base.storeyIds[0];
  const otherStorey = base.storeyIds[1];
  const members = membershipOf(base).get(storeyId);
  const moved = members[0];
  if (moved === undefined || otherStorey === undefined) {
    return { constructed: false, reason: 'the base model has too few storeys to construct the case' };
  }

  // A: rewrite the storey's membership list, naming the elements it should
  // contain. Targets the relationship node directly.
  const opA = { opId: 'ns-a', type: 'storey-set-members', storeyId, members };
  // B: move one of those elements to the other storey. Targets the element.
  const opB = { opId: 'ns-b', type: 'storey-move', entityNodeId: moved, storeyId: otherStorey };

  // The SHIPPED predicate, over footprints built the shipped way.
  const dag = buildStateDag(base);
  const fpA = computeFootprint(dag, {
    opId: opA.opId,
    kind: 'property-edit',
    targetNodeIds: [storeyNodeIdOf(storeyId)],
  });
  const fpB = computeFootprint(dag, { opId: opB.opId, kind: 'property-edit', targetNodeIds: [moved] });
  const verdict = conflictPredicate(fpA, fpB, { epsilonMm: DEFAULT_EPSILON_MM });

  // Ground truth, over an observable that CAN see membership.
  const world = { state: base, membership: membershipOf(base) };
  const moveOp = (w) => {
    const state = P.cloneState(w.state);
    const e = state.entities.get(opB.entityNodeId);
    if (e) e.storeyId = opB.storeyId;
    return { state, membership: membershipOf(state) };
  };
  const stepA = (w) => applyExtended(P, w, opA, semantics);

  const orderAB = (() => {
    let w = stepA(world);
    w = moveOp(w);
    return w;
  })();
  const orderBA = (() => {
    let w = moveOp(world);
    w = stepA(w);
    return w;
  })();

  const bytesAgree = canonicalStateBytes(orderAB.state) === canonicalStateBytes(orderBA.state);
  const membershipAgrees = membershipDigest(orderAB.membership) === membershipDigest(orderBA.membership);

  return {
    constructed: true,
    semantics,
    // What the shipped predicate says about the pair.
    predicateSaysConflict: verdict.conflict,
    predicateStructural: verdict.structural,
    predicateSpatial: verdict.spatial,
    // What the two observables say.
    scoredObservableSaysConverged: bytesAgree,
    membershipObservableSaysConverged: membershipAgrees,
    // The catch: predicate clears the pair, the richer observable diverges.
    unsoundAutoMergeOnAnUnmodelledOp: verdict.conflict === false && membershipAgrees === false,
    // And the reason the battery can never report it.
    opKindsTheGeneratorCanProduce: 4,
    opKindThatExposesIt: 'storey-set-members',
    generatorProducesIt: false,
    invariantsListed: [
      'spatial-structure membership, which lives only in the DAG and never in the state',
      'every relationship other than the host to opening link',
      'units, classification, type assignment and material association',
      'the order of ops within one client',
    ],
    checkThatIsNotInvariant: 'membershipDigest, a digest of every storey to element list',
  };
}

