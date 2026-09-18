/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scoring the CLAIM stages (issue #4955): successor claims by stratum and
 * confidence, split claims against the answer key, and the two negative
 * controls. Split out of `score.mjs` for size; `scorePair` there calls in.
 */

import { ratio } from './score.mjs';

/**
 * Mutations whose counterpart is NOT a content match but a `SuccessorClaim`
 * (issue #4955): the stratum each is scored under and the confidences the
 * harness accepts as agreeing. A thickened wall's old box nests inside its
 * new one, so only `footprint` agrees. A swapped family shares a container
 * and a position; its box may or may not still overlap heavily (a door
 * swapped for one the same size does, a chair for a sofa does not), and the
 * engine tries the stronger profile first — so `footprint` is an agreeing
 * answer there too, and the stratum measures whether the pair was found
 * rather than which profile happened to find it. Recall is credited for a
 * claim with the right head at ANY confidence.
 */
export const EXPECTED_SUCCESSOR = {
  thickened: { stratum: 'footprint', agrees: ['footprint'] },
  swapped: { stratum: 'position', agrees: ['position', 'footprint'] },
};

/** Mutations whose counterpart is a `split` claim: whole = base, pieces = heads. */
const SPLIT_KINDS = new Set(['splitLength']);

/**
 * Score the successor stage's claims against the key (issue #4955).
 *
 * The stratum keys are the EXPECTED confidence (`bySuccessor.footprint` is the
 * thickened population, `bySuccessor.position` the swapped one) so that recall
 * has a fixed denominator per profile, exactly as `byKind` is keyed by the
 * mutation rather than by the verdict. `bySuccessorConfidence` is the
 * `byTier` analogue: precision per REPORTED profile, so a profile that starts
 * guessing is visible even when the other one is carrying the recall.
 *
 * Every claim whose head is not the base's true counterpart increments exactly
 * one of two negative-control counters, both with a zero ceiling:
 * `insertedNearby` when the head is the small element planted inside a deleted
 * element's box, `neighbourSuccessor` for any other wrong partner — including
 * every claim on a `deleted` base, which has no counterpart at all, and a
 * claim that offers half of a split as the whole's successor.
 *
 * A claim on a base the key expected CONTENT matching to recover (a `renamed`
 * element the content pass abstained on) with the right head is neither: the
 * partner is right, only the stage is unexpected. Counted as correct for
 * precision and reported as `recoveredContentKinds`.
 */
export function scoreSuccessors(key, successors, { expected, kindOf, insertedNearby }) {
  const want = new Map();
  for (const element of key.elements) {
    const expectation = EXPECTED_SUCCESSOR[element.kind];
    if (expectation === undefined) continue;
    want.set(element.base, { head: element.head[0], ...expectation });
  }
  const row = () => ({ population: 0, recalled: 0, kindAgreed: 0, claimed: 0, correct: 0, wrong: 0 });
  const bySuccessor = {};
  for (const { stratum } of Object.values(EXPECTED_SUCCESSOR)) bySuccessor[stratum] = row();
  for (const { stratum } of want.values()) bySuccessor[stratum].population++;
  const bySuccessorConfidence = {};
  const reportedRow = (confidence) =>
    (bySuccessorConfidence[confidence] ??= { claimed: 0, correct: 0, wrong: 0 });
  const falseSuccessors = { insertedNearby: 0, neighbourSuccessor: 0 };
  const recalled = new Set();
  const wrongClaims = [];
  let recoveredContentKinds = 0;

  for (const claim of successors) {
    const baseRef = claim.base.ref;
    const headRef = claim.head.ref;
    const reported = reportedRow(claim.confidence ?? 'unknown');
    reported.claimed++;
    const expectation = want.get(baseRef);
    let correct = false;
    if (expectation) {
      const stratum = bySuccessor[expectation.stratum];
      stratum.claimed++;
      if (expectation.head === headRef) {
        correct = true;
        stratum.correct++;
        if (!recalled.has(baseRef)) {
          recalled.add(baseRef);
          stratum.recalled++;
          if (expectation.agrees.includes(claim.confidence)) stratum.kindAgreed++;
        }
      } else stratum.wrong++;
    } else if (
      !insertedNearby.has(headRef) &&
      !SPLIT_KINDS.has(kindOf.get(baseRef)) &&
      (expected.get(baseRef)?.has(headRef) ?? false)
    ) {
      correct = true;
      recoveredContentKinds++;
    }
    if (correct) {
      reported.correct++;
      continue;
    }
    reported.wrong++;
    if (insertedNearby.has(headRef)) falseSuccessors.insertedNearby++;
    else falseSuccessors.neighbourSuccessor++;
    wrongClaims.push({
      base: baseRef,
      baseKind: kindOf.get(baseRef) ?? 'unkeyed',
      head: headRef,
      confidence: claim.confidence,
      overlap: claim.overlap,
      distance: claim.distance,
    });
  }

  const finish = (rows, withRecall) => {
    const out = {};
    for (const [name, r] of Object.entries(rows)) {
      out[name] = {
        ...r,
        ...(withRecall
          ? {
              recall: ratio(r.recalled, r.population),
              kindAgreement: ratio(r.kindAgreed, r.recalled),
            }
          : {}),
        precision: ratio(r.correct, r.claimed),
      };
    }
    return out;
  };
  return {
    bySuccessor: finish(bySuccessor, true),
    bySuccessorConfidence: finish(bySuccessorConfidence, false),
    falseSuccessors,
    successorClaims: successors.length,
    recoveredContentKinds,
    wrongSuccessors: wrongClaims.slice(0, 20),
  };
}

/**
 * Score the split/merge detector's claims against the key (issue #4955).
 *
 * A claim is correct only when it is a `split` whose whole is a `splitLength`
 * base and whose piece SET is exactly that base's two head products — the
 * same set-equality rule the N:N content match is scored by. Anything else
 * is wrong: a split with a piece missing or a stranger added, and every
 * `merge`, because no mutation in the corpus merges anything.
 *
 * `kindAgreement` is about the confidence: `verified` is expected whenever
 * the whole and both pieces carry a proved volume, `extent` otherwise. The
 * geometry pass decides which — an open shell has no volume by design — so
 * the expectation is read off the fingerprints, not assumed.
 */
export function scoreSplits(key, splitMerges, { hasVolume, kindOf, headOrigin }) {
  const want = new Map();
  for (const element of key.elements) {
    if (SPLIT_KINDS.has(element.kind)) want.set(element.base, new Set(element.head));
  }
  const bySplit = { population: want.size, recalled: 0, kindAgreed: 0, claimed: 0, correct: 0, wrong: 0 };
  const byConfidence = {};
  const recalled = new Set();
  const wrongClaims = [];
  let mergeClaims = 0;

  for (const claim of splitMerges) {
    bySplit.claimed++;
    byConfidence[claim.confidence] = (byConfidence[claim.confidence] ?? 0) + 1;
    const wholeRef = claim.whole.ref;
    const pieces = claim.pieces.map((piece) => piece.ref);
    const truth = claim.kind === 'split' ? want.get(wholeRef) : undefined;
    if (claim.kind !== 'split') mergeClaims++;
    // SET equality, with the pieces de-duplicated first: `[h1, h1]` against
    // `{h1, h2}` has the right length and every member in the truth, and is
    // still not the split the key describes.
    const distinct = new Set(pieces);
    const correct =
      truth !== undefined &&
      distinct.size === pieces.length &&
      distinct.size === truth.size &&
      pieces.every((ref) => truth.has(ref));
    if (!correct) {
      bySplit.wrong++;
      // WHAT was claimed, in the key's terms, so a wrong claim reads as
      // "the two copies of a duplicated group" rather than as three numbers.
      wrongClaims.push({
        kind: claim.kind,
        confidence: claim.confidence,
        whole: wholeRef,
        wholeKind: kindOf.get(wholeRef) ?? headOrigin.get(wholeRef) ?? 'unkeyed',
        pieces,
        pieceOrigins: pieces.map((ref) => headOrigin.get(ref) ?? kindOf.get(ref) ?? 'unkeyed'),
      });
      continue;
    }
    bySplit.correct++;
    if (recalled.has(wholeRef)) continue;
    recalled.add(wholeRef);
    bySplit.recalled++;
    const proved = hasVolume.has(`b${wholeRef}`) && pieces.every((ref) => hasVolume.has(`h${ref}`));
    if (claim.confidence === (proved ? 'verified' : 'extent')) bySplit.kindAgreed++;
  }
  return {
    bySplit: {
      ...bySplit,
      recall: ratio(bySplit.recalled, bySplit.population),
      precision: ratio(bySplit.correct, bySplit.claimed),
      kindAgreement: ratio(bySplit.kindAgreed, bySplit.recalled),
      byConfidence,
      mergeClaims,
    },
    wrongSplits: wrongClaims.slice(0, 20),
  };
}
