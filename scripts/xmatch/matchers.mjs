/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MUTANT matchers the harness is checked against.
 *
 * A validation fixture that cannot reject an obviously wrong matcher proves
 * nothing about the right one, so `run.mjs --self-test` runs both of these
 * through the exact same scoring path and asserts the thresholds reject each.
 * They fail in opposite directions on purpose: one claims everything, the
 * other claims nothing, and a fixture blind to either is broken in a way that
 * would otherwise be invisible.
 */

/**
 * MUTANT 1 — pairs everything it is handed, in a fixed order, claiming the
 * strongest tier. A fixture that cannot fail this is measuring nothing: it
 * scores maximal recall while pairing deleted elements with inserted ones.
 */
export function alwaysMatchMatcher(base, head) {
  const order = (list) =>
    [...list].sort((a, b) => a.ifcType.localeCompare(b.ifcType) || a.dataHash.localeCompare(b.dataHash));
  const bases = order(base);
  const heads = order(head);
  const matches = [];
  for (let i = 0; i < Math.min(bases.length, heads.length); i++) {
    matches.push({
      kind: 'renamed',
      tier: 'geometry-hash',
      dataHash: bases[i].dataHash,
      base: [bases[i]],
      head: [heads[i]],
    });
  }
  return { matches, counts: null };
}

/** MUTANT 2 — never claims anything. Perfect precision, zero recall; a fixture
 *  that passes this is scoring only the pairs the matcher chose to produce. */
export function alwaysAbstainMatcher() {
  return { matches: [], counts: null };
}


/**
 * MUTANT 3 — the real matcher, then greedily pairs everything it left over.
 *
 * This is the specific regression the other two mutants do NOT model: a
 * matcher that buys RECALL by lowering its bar. Measured, not assumed — it
 * beats the real engine's recall on every model in the corpus:
 *
 *   duplex  0.920128 -> 0.926518   at precision 0.903427
 *   AC20    0.825397 -> 0.841270   at precision 0.791045
 *   rvt01   0.939693 -> 0.950658   at precision 0.942391
 *
 * So it clears every recall floor, and the fixture must still reject it. It
 * does, twice over: on the precision floors, and on `falsePairs.wrongPartner`,
 * whose ceiling is ZERO. That second one is the real defence — every wrong
 * pair increments exactly one negative-control counter, so precision below 1
 * is a hard failure before any precision floor is consulted, and the cheapest
 * way to game a recall floor is also the loudest way to fail.
 */
export function overEagerMatcher(base, head, realMatches) {
  // Only RETIRING matches count as claimed. A `duplicated` / `ambiguous`
  // record is the engine declining to guess, and its members are precisely
  // what this mutant exists to guess about — treating them as claimed left it
  // with nothing to be over-eager with, which is how the first version of this
  // mutant came out identical to the real matcher.
  const retiring = new Set(['renamed', 'moved', 'reshaped']);
  const claimedBase = new Set();
  const claimedHead = new Set();
  for (const match of realMatches) {
    if (!retiring.has(match.kind)) continue;
    for (const entity of match.base) claimedBase.add(entity.ref);
    for (const entity of match.head) claimedHead.add(entity.ref);
  }
  const realMatchesRetiring = realMatches.filter((match) => retiring.has(match.kind));
  // Bucket the leftovers exactly as the engine does, then pair them off in
  // order INSIDE each bucket — no geometry sub-bucketing, no unique-nearest
  // requirement, no component-agreement veto. This is the engine with its
  // abstentions removed: every candidate it declined to guess about, guessed.
  const bucket = (entity) => `${entity.ifcType}\u0000${entity.dataHash}`;
  const buckets = new Map();
  for (const entity of base) {
    if (claimedBase.has(entity.ref)) continue;
    const key = bucket(entity);
    if (!buckets.has(key)) buckets.set(key, { base: [], head: [] });
    buckets.get(key).base.push(entity);
  }
  for (const entity of head) {
    if (claimedHead.has(entity.ref)) continue;
    const key = bucket(entity);
    if (!buckets.has(key)) buckets.set(key, { base: [], head: [] });
    buckets.get(key).head.push(entity);
  }

  const matches = [...realMatchesRetiring];
  for (const group of buckets.values()) {
    group.base.sort((a, b) => a.ref - b.ref);
    group.head.sort((a, b) => a.ref - b.ref);
    for (let i = 0; i < Math.min(group.base.length, group.head.length); i++) {
      matches.push({
        kind: 'renamed',
        tier: 'residue-1-1',
        dataHash: group.base[i].dataHash,
        base: [group.base[i]],
        head: [group.head[i]],
      });
    }
  }
  return { matches, counts: null };
}

// ---------------------------------------------------------------------------
// Mutants for the claim stages (issue #4955): split/merge and successors.
//
// The three content mutants above keep the REAL engine's split and successor
// claims, so their rejection stays a statement about content matching. The
// four below keep the real content matches and mutate one claim stage each,
// so their rejection is a statement about the stratum they target — and each
// declares (`mustFailOn`) which clause family has to reject it. A mutant
// rejected only by an unrelated clause would prove nothing about the stratum
// it was written for, which is the vacuity `--self-test` exists to rule out.
//
// `applicable` is false when the pair holds no material for the mutation —
// decided from the KEY's populations, not from what the engine claimed: on a
// model with no thickened, swapped or split element the claim floors are
// skipped, so a claim mutant there could only survive vacuously. The run
// skips it, and requires every mutant to have been applied and rejected on at
// least one pair.
// ---------------------------------------------------------------------------

/** Does the key expect any successor or split claim on this pair? */
function expectsClaims(key) {
  return key.elements.some((element) =>
    element.kind === 'thickened' || element.kind === 'swapped' || element.kind === 'splitLength',
  );
}

/** Kinds whose content match retires the pair (mirrors `score.mjs`). */
const RETIRING = new Set(['renamed', 'moved', 'reshaped', 'respecified']);

function boxIoU(a, b) {
  let intersection = 1;
  let volumeA = 1;
  let volumeB = 1;
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.max(a.min[axis], b.min[axis]);
    const hi = Math.min(a.max[axis], b.max[axis]);
    if (hi <= lo) return 0;
    intersection *= hi - lo;
    volumeA *= a.max[axis] - a.min[axis];
    volumeB *= b.max[axis] - b.min[axis];
  }
  const union = volumeA + volumeB - intersection;
  return union > 0 ? intersection / union : 0;
}

/** The entities the real content pass left unretired, per side. */
function residue(base, head, real) {
  const claimedBase = new Set();
  const claimedHead = new Set();
  for (const match of real.matches) {
    if (!RETIRING.has(match.kind)) continue;
    for (const entity of match.base) claimedBase.add(entity.ref);
    for (const entity of match.head) claimedHead.add(entity.ref);
  }
  return {
    base: base.filter((entity) => !claimedBase.has(entity.ref) && entity.aabb),
    head: head.filter((entity) => !claimedHead.has(entity.ref) && entity.aabb),
  };
}

/**
 * MUTANT 4 — `overlap-successor`: every deleted box that touches an added box
 * is a `footprint` successor. No threshold, no uniqueness, no family. This is
 * the successor stage with its evidence removed, and the small element the
 * `insertedNearby` control plants inside a deleted element's box is exactly
 * what it must be caught pairing.
 */
export function overlapSuccessorMutant(base, head, real) {
  const left = residue(base, head, real);
  const successors = [];
  for (const b of left.base) {
    for (const h of left.head) {
      const overlap = boxIoU(b.aabb, h.aabb);
      if (overlap > 0) successors.push({ confidence: 'footprint', base: b, head: h, overlap, distance: 0 });
    }
  }
  return {
    applicable: successors.length > 0,
    mustFailOn: /^falseSuccessors\./,
    result: { matches: real.matches, splitMerges: real.splitMerges, successors },
  };
}

/**
 * MUTANT 5 — `rotated-claims`: the real claims with their partners shuffled
 * one step. Every successor keeps its base and takes the NEXT claim's head;
 * every split keeps its whole and takes the next claim's pieces. Same claim
 * count, same confidences, every partner wrong — the pure precision failure
 * a recall floor cannot see. A lone claim takes an inserted head (successor)
 * or loses a piece (split) instead, so one claim is still one wrong claim.
 */
export function rotatedClaimsMutant(head, real, key) {
  const inserted = new Set(key.insertedHeadIds);
  const spare = head.find((entity) => inserted.has(entity.ref));
  // The CONFIDENCE is rotated too, to a different valid value: a harness
  // that stopped scoring `kindAgreement` for claims would otherwise not see
  // this mutant's confidences at all, and the partner rotation alone would
  // keep rejecting it for the wrong reason.
  const otherConfidence = (confidence) => (confidence === 'footprint' ? 'position' : 'footprint');
  const otherSplitConfidence = (confidence) => (confidence === 'verified' ? 'extent' : 'verified');
  const successors = real.successors.map((claim, i, all) => ({
    ...claim,
    confidence: otherConfidence(claim.confidence),
    head: all.length > 1 ? all[(i + 1) % all.length].head : (spare ?? claim.head),
  }));
  const splitMerges = real.splitMerges.map((claim, i, all) => ({
    ...claim,
    confidence: otherSplitConfidence(claim.confidence),
    pieces: all.length > 1 ? all[(i + 1) % all.length].pieces : claim.pieces.slice(1),
  }));
  return {
    applicable: expectsClaims(key) && (successors.length > 0 || splitMerges.length > 0),
    mustFailOn: /^(bySuccessor\.\w+\.precision|bySuccessorConfidence\.|falseSuccessors\.|bySplit\.precision)/,
    result: { matches: real.matches, splitMerges, successors },
  };
}

/**
 * MUTANT 6 — `respecified-as-renamed`: the geometry-only stage's verdicts
 * relabelled as tier-1 `renamed`. The pairs are still right, so recall and
 * precision cannot see it; only the kind and the tier can. A harness that
 * scored `respecified` recall from a `renamed` record would pass this.
 */
export function respecifiedAsRenamedMutant(real) {
  const matches = real.matches.map((match) =>
    match.kind === 'respecified' ? { ...match, kind: 'renamed', tier: 'geometry-hash' } : match,
  );
  return {
    applicable: real.matches.some((match) => match.kind === 'respecified'),
    mustFailOn: /^(byKind\.respecified\.kindAgreement|respecifiedControl\.reportedRenamed)/,
    result: { matches, splitMerges: real.splitMerges, successors: real.successors },
  };
}

/**
 * MUTANT 8 — `merge-drops-a-piece` (issue #4989): every real `merge` claim,
 * minus one of its two pieces. Byte-identical to the real engine everywhere
 * else — same successors, same splits, same content matches — so this is the
 * pure precision failure for `byMerge` specifically: a harness that scored
 * `byMerge` from `bySplit`'s claims, or not at all, would wave it through.
 */
export function mergeDropsAPieceMutant(real, key) {
  const splitMerges = real.splitMerges.map((claim) =>
    claim.kind === 'merge' && claim.pieces.length > 1 ? { ...claim, pieces: claim.pieces.slice(1) } : claim,
  );
  return {
    applicable:
      key.elements.some((element) => element.kind === 'merged')
      && real.splitMerges.some((claim) => claim.kind === 'merge'),
    mustFailOn: /^byMerge\.(precision|recall)/,
    result: { matches: real.matches, splitMerges, successors: real.successors },
  };
}

/**
 * MUTANT 7 — `silent-claims`: the real content matches and no claim of
 * either kind. Perfect precision on the claim strata, zero recall; a fixture
 * that only had ceilings and precision floors for successors and splits would
 * wave it through.
 */
export function silentClaimsMutant(real, key) {
  return {
    applicable: expectsClaims(key),
    mustFailOn: /^(bySuccessor\.\w+\.recall|bySplit\.recall)/,
    result: { matches: real.matches, splitMerges: [], successors: [] },
  };
}
