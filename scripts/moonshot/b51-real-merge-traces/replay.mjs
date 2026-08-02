/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 step 3: the replay, and the read-set check the prediction names.
 *
 * Split out of run.mjs for the house size rule. One pass over a schedule
 * stream scores THREE predicate variants against the SAME ground truth, so the
 * three numbers are attributions of the same events rather than three
 * independent runs that happen to be reported in one table.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';


export async function loadProvenance(REPO_ROOT) {
  const dist = path.join(REPO_ROOT, 'packages/provenance/dist/index.js');
  if (!existsSync(dist)) {
    throw new Error(
      'packages/provenance is not built. Run `pnpm --filter @ifc-lite/provenance build` first ' +
        '(this runner reads the same dist g2-merge-soundness.mjs reads).',
    );
  }
  return import(dist);
}

const CELLS = [
  { id: 'lazyEnforced', cuts: 'lazy', containment: 'enforced' },
  { id: 'lazyOff', cuts: 'lazy', containment: 'off' },
  { id: 'derivedEnforced', cuts: 'derived', containment: 'enforced' },
  { id: 'derivedOff', cuts: 'derived', containment: 'off' },
];

/* ---------- the read-set check the prediction names ---------- */

/**
 * Entity-granularity read and write sets over the HOSTING relation, computed
 * without touching geometry.
 *
 * This is the check the finishing plan's B4.2 entry says would catch the
 * residual hazard "without any geometry at all". It was prose there and is
 * code here, so clause b51-p1c can fail.
 *
 * The rule the structural half of the predicate misses, and why: footprint.ts
 * closes an op's targets over their DAG ancestors but STOPS at the first
 * relationship-kind ancestor, because continuing would make every edit in a
 * building conflict with every other. That exclusion is correct for spatial
 * containment, whose only job is aggregation, and wrong for the hosting
 * relation, which is a real dependency: an opening's existence depends on its
 * host's. So the hosting edge is invisible to the structural rule by
 * construction, and this function restores exactly that one edge.
 */
function hostingSets(state, op) {
  const reads = new Set();
  const writes = new Set();
  const openingsOf = (hostId) => {
    const out = [];
    for (const [id, e] of state.entities) if (e.hostId === hostId) out.push(id);
    return out;
  };
  const ownerOfMesh = (meshNodeId) => {
    for (const [id, e] of state.entities) if (e.meshes.has(meshNodeId)) return id;
    return undefined;
  };
  const ownerOfPset = (psetNodeId) => {
    for (const [id, e] of state.entities) if (e.psets.has(psetNodeId)) return id;
    return undefined;
  };

  switch (op.type) {
    case 'entity-add': {
      writes.add(op.entity.entityNodeId);
      // The add READS its host: it cannot exist without it, and under every
      // cut semantics the host's geometry is a function of its openings.
      if (op.entity.hostId !== undefined) {
        reads.add(op.entity.hostId);
        writes.add(op.entity.hostId);
      }
      break;
    }
    case 'entity-remove': {
      writes.add(op.entityNodeId);
      const e = state.entities.get(op.entityNodeId);
      if (e?.hostId !== undefined) {
        reads.add(e.hostId);
        writes.add(e.hostId);
      }
      // Removing a host cascades to its openings.
      for (const child of openingsOf(op.entityNodeId)) writes.add(child);
      break;
    }
    case 'geometry-replace': {
      const owner = ownerOfMesh(op.meshNodeId);
      if (owner !== undefined) {
        writes.add(owner);
        const e = state.entities.get(owner);
        if (e?.hostId !== undefined) {
          reads.add(e.hostId);
          writes.add(e.hostId);
        }
        for (const child of openingsOf(owner)) {
          reads.add(child);
          writes.add(child);
        }
      }
      break;
    }
    case 'attr-set': {
      const owner = ownerOfPset(op.psetNodeId);
      if (owner !== undefined) writes.add(owner);
      break;
    }
    default:
      break;
  }
  return { reads, writes };
}

function intersects(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) return true;
  return false;
}

function hostingConflict(state, opA, opB) {
  const a = hostingSets(state, opA);
  const b = hostingSets(state, opB);
  return (
    intersects(a.writes, b.writes) || intersects(a.writes, b.reads) || intersects(a.reads, b.writes)
  );
}

/* ---------- predicate variants, scored against the same ground truth ---------- */

/**
 * One pass over `schedules` schedules under one semantics cell, scoring three
 * predicate variants against the SAME ground truth (both replay orders,
 * canonical bytes compared) so the three numbers are attributions of the same
 * events rather than three separate runs.
 *
 * Variants:
 *   full        structural OR spatial -- what the codebase ships.
 *   structural  spatial rule ablated  -- what B4.2's ablation measures.
 *   readSet     structural OR hosting read-set, spatial DELETED -- the
 *               prediction's replacement.
 */
export function scoreCell(P, { schedules, seed, semantics, generatorSemantics, epsilonMm }) {
  const {
    buildBaseModel,
    generateClientOps,
    mulberry32,
    buildStateDag,
    computeMergeOpFootprint,
    conflictPredicate,
    applyOps,
    canonicalStateBytes,
    OpApplicationError,
  } = P;

  const rng = mulberry32(seed);
  const tally = {
    schedules,
    // Ground truth over all schedules.
    groundTruthCommutes: 0,
    groundTruthDoesNot: 0,
    variants: {
      full: emptyVariant(),
      structural: emptyVariant(),
      readSet: emptyVariant(),
    },
    // The spatial rule's own accounting, which is what the exam asks for.
    spatialFiredFlagged: 0,
    spatialFiredTrue: 0,
    spatialFiredFalse: 0,
    spatialOnlyFlagged: 0,
    spatialOnlyTrueConflicts: 0,
    spatialOnlyFalseConflicts: 0,
    // Hosting-relation events, so the residual hazard can be counted directly.
    hostingReadWriteSchedules: 0,
    hostingReadWriteTrueConflicts: 0,
  };

  for (let s = 0; s < schedules; s++) {
    const base = buildBaseModel(rng);
    const opsA = generateClientOps(base, { client: 'a', scheduleIndex: s, rng }, generatorSemantics);
    const opsB = generateClientOps(base, { client: 'b', scheduleIndex: s, rng }, generatorSemantics);

    // Ground truth: replay both orders under the cell's scored semantics.
    let commutes;
    try {
      const ab = applyOps(applyOps(base, opsA, semantics), opsB, semantics);
      const ba = applyOps(applyOps(base, opsB, semantics), opsA, semantics);
      commutes = canonicalStateBytes(ab) === canonicalStateBytes(ba);
    } catch (err) {
      if (!(err instanceof OpApplicationError) && err?.name !== 'SpatialRejectionError') throw err;
      commutes = false;
    }
    if (commutes) tally.groundTruthCommutes += 1;
    else tally.groundTruthDoesNot += 1;

    // Footprints once, three predicates over them.
    const dag = buildStateDag(base);
    const fpsA = opsA.map((op) => computeMergeOpFootprint(dag, base, op));
    const fpsB = opsB.map((op) => computeMergeOpFootprint(dag, base, op));

    let structural = false;
    let spatial = false;
    for (const fa of fpsA) {
      for (const fb of fpsB) {
        const r = conflictPredicate(fa, fb, { epsilonMm });
        if (r.structural) structural = true;
        if (r.spatial) spatial = true;
      }
    }
    let hosting = false;
    for (const oa of opsA) {
      for (const ob of opsB) {
        if (hostingConflict(base, oa, ob)) {
          hosting = true;
          break;
        }
      }
      if (hosting) break;
    }

    record(tally.variants.full, structural || spatial, commutes);
    record(tally.variants.structural, structural, commutes);
    record(tally.variants.readSet, structural || hosting, commutes);

    if (spatial) {
      tally.spatialFiredFlagged += 1;
      if (commutes) tally.spatialFiredFalse += 1;
      else tally.spatialFiredTrue += 1;
    }
    if (spatial && !structural) {
      tally.spatialOnlyFlagged += 1;
      if (commutes) tally.spatialOnlyFalseConflicts += 1;
      else tally.spatialOnlyTrueConflicts += 1;
    }
    if (hosting) {
      tally.hostingReadWriteSchedules += 1;
      if (!commutes) tally.hostingReadWriteTrueConflicts += 1;
    }
  }
  return tally;
}

function emptyVariant() {
  return { flagged: 0, trueConflicts: 0, falseConflicts: 0, unsoundAutoMerges: 0, autoMerged: 0 };
}

function record(v, flagged, commutes) {
  if (flagged) {
    v.flagged += 1;
    if (commutes) v.falseConflicts += 1;
    else v.trueConflicts += 1;
  } else {
    v.autoMerged += 1;
    // Cleared by the predicate and the orders do not actually commute: the
    // predicate was wrong in the unsafe direction.
    if (!commutes) v.unsoundAutoMerges += 1;
  }
}

function mergeTallies(list) {
  const out = JSON.parse(JSON.stringify(list[0]));
  for (const t of list.slice(1)) {
    out.schedules += t.schedules;
    out.groundTruthCommutes += t.groundTruthCommutes;
    out.groundTruthDoesNot += t.groundTruthDoesNot;
    for (const k of ['full', 'structural', 'readSet']) {
      for (const f of Object.keys(out.variants[k])) out.variants[k][f] += t.variants[k][f];
    }
    for (const f of [
      'spatialFiredFlagged',
      'spatialFiredTrue',
      'spatialFiredFalse',
      'spatialOnlyFlagged',
      'spatialOnlyTrueConflicts',
      'spatialOnlyFalseConflicts',
      'hostingReadWriteSchedules',
      'hostingReadWriteTrueConflicts',
    ]) {
      out[f] += t[f];
    }
  }
  return out;
}

function rates(t) {
  // GROUND TRUTH, NOT A PREDICATE-DERIVED COUNT. This was
  // `autoMerged + falseConflicts`, which equals the commuting count only while
  // `unsoundAutoMerges` is zero: `autoMerged` includes every schedule the
  // predicate cleared, and an unsound clear is a schedule that does NOT
  // commute. So a predicate variant that admits one would inflate its own
  // denominator and under-report its false-conflict rate against the kill bar
  // -- the one direction an error here must not go. The two agree in every
  // committed cell, so this changes no published figure; it removes the way it
  // could stop agreeing.
  const groundTruthConvergent = t.groundTruthCommutes;
  return {
    schedules: t.schedules,
    groundTruthCommutes: t.groundTruthCommutes,
    autoMerged: t.variants.full.autoMerged,
    flagged: t.variants.full.flagged,
    trueConflicts: t.variants.full.trueConflicts,
    falseConflicts: t.variants.full.falseConflicts,
    groundTruthConvergent,
    // The plan's own kill-criterion quantity, same denominator as the battery.
    falseConflictRate: groundTruthConvergent === 0 ? 0 : t.variants.full.falseConflicts / groundTruthConvergent,
    unsoundAutoMerges: t.variants.full.unsoundAutoMerges,
    structuralOnlyUnsoundAutoMerges: t.variants.structural.unsoundAutoMerges,
    readSetUnsoundAutoMerges: t.variants.readSet.unsoundAutoMerges,
    readSetFalseConflicts: t.variants.readSet.falseConflicts,
    spatialFiredFlagged: t.spatialFiredFlagged,
    spatialFiredTrueConflicts: t.spatialFiredTrue,
    spatialFiredFalseConflicts: t.spatialFiredFalse,
    spatialFiredFalseConflictRate: t.spatialFiredFlagged === 0 ? 0 : t.spatialFiredFalse / t.spatialFiredFlagged,
    spatialOnlyFlagged: t.spatialOnlyFlagged,
    spatialOnlyTrueConflicts: t.spatialOnlyTrueConflicts,
    spatialOnlyFalseConflicts: t.spatialOnlyFalseConflicts,
    spatialOnlyTrueConflictsPerThousand: (t.spatialOnlyTrueConflicts * 1000) / t.schedules,
    // Precision of the spatial rule when it is the ONLY rule that fired: how
    // often being alone in flagging a schedule was being right about it.
    spatialOnlyPrecision:
      t.spatialOnlyFlagged === 0 ? 0 : t.spatialOnlyTrueConflicts / t.spatialOnlyFlagged,
    // What replacing the spatial rule with the read-set check costs in
    // over-approximation. Positive means the substitute refuses more
    // commuting schedules than the rule it replaces.
    // Same denominator correction as above, for the same reason: the read-set
    // variant is exactly the one whose unsound count clause b51-p1c is about,
    // so it is the last place to let its own clears set its denominator.
    readSetFalseConflictRate:
      groundTruthConvergent === 0 ? 0 : t.variants.readSet.falseConflicts / groundTruthConvergent,
    readSetMinusFullFalseConflicts: t.variants.readSet.falseConflicts - t.variants.full.falseConflicts,
    hostingReadWriteSchedules: t.hostingReadWriteSchedules,
    hostingReadWriteTrueConflicts: t.hostingReadWriteTrueConflicts,
  };
}

export async function measure({ repoRoot, schedules, seeds, baseSeed }) {
  const P = await loadProvenance(repoRoot);
  const wilson = P.wilsonInterval;
  const epsilonMm = P.DEFAULT_EPSILON_MM;
  const started = Date.now();

  const out = { schedules, seeds, baseSeed, epsilonMm, regenerated: {}, scheduleMatched: {} };
  const lazyEnforced = { cuts: 'lazy', containment: 'enforced' };

  for (const cell of CELLS) {
    const semantics = { cuts: cell.cuts, containment: cell.containment };
    const regen = [];
    const matched = [];
    for (let i = 0; i < seeds; i++) {
      const seed = baseSeed + i;
      regen.push(scoreCell(P, { schedules, seed, semantics, generatorSemantics: semantics, epsilonMm }));
      matched.push(
        scoreCell(P, { schedules, seed, semantics, generatorSemantics: lazyEnforced, epsilonMm }),
      );
    }
    out.regenerated[cell.id] = {
      ...rates(mergeTallies(regen)),
      // Per-seed, so a reader can see whether the headline is one lucky
      // stream or a stable property of the cell. This is what eight seeds
      // buy over the single stream the published grid was measured on.
      perSeedSpatialOnlyTrueConflicts: regen.map((t) => t.spatialOnlyTrueConflicts),
    };
    out.scheduleMatched[cell.id] = rates(mergeTallies(matched));
    const r = out.regenerated[cell.id];
    // Same interval the published grid reports, so the two are comparable.
    const w = wilson(r.spatialFiredFalseConflicts, r.spatialFiredFlagged);
    out.regenerated[cell.id].spatialFiredFalseConflictRateWilson95 = { low: w.low, high: w.high };
  }
  out.elapsedMs = Date.now() - started;
  return out;
}

