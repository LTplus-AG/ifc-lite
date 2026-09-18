/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scoring: reported content matches against the answer key.
 *
 * Four rules decide everything here, and each is a defence against a specific
 * way a fixture stops being able to fail.
 *
 * 1. **The denominator is fixed.** Recall is over every keyed element the
 *    mutation program says has a counterpart, whether or not the matcher
 *    mentioned it. Scoring only over the pairs the matcher produced is the
 *    first thing a red team would try, and it makes an engine that abstains on
 *    99% of the model score 100%.
 * 2. **`ambiguous` is an abstention, not a miss and not a false pair.** The
 *    engine's contract is that it does not guess; punishing it for honouring
 *    that would push it toward guessing. Abstentions are counted and reported
 *    separately, and they lower recall (the element was not recovered) without
 *    touching precision (nothing wrong was claimed).
 * 3. **A pair is judged by the answer key, never by the fingerprints.** The key
 *    maps source express id → head express id, produced by construction. No
 *    hash, name or box is consulted here.
 * 4. **The negative controls are hard failures.** Elements the key says were
 *    deleted, and head elements the key says are new, have no counterpart at
 *    all; pairing one is not a precision cost to be averaged away, it is a
 *    wrong claim of identity.
 */

/** Kinds whose {@link ContentMatch} asserts identity and retires the
 *  `added`/`deleted` entries. The rest are reported groups: abstentions. */
const PAIRING_KINDS = new Set(['renamed', 'moved', 'reshaped', 'respecified']);

/** Expected `ContentMatchKind` for each mutation the generator applies. */
const EXPECTED_KIND = {
  renamed: 'renamed',
  moved: 'moved',
  reshaped: 'reshaped',
  // Same world geometry, different data: the geometry-only stage (#4955).
  // `renamed` here would mean the data hash called two different payloads
  // equal, which is the one thing that stage must never do.
  respecified: 'respecified',
  // A re-sampled arc is a genuine shape change to a triangle-multiset hash;
  // both `reshaped` (box shrank by the sagitta) and `moved` (box centre
  // shifted, size within tolerance) are honest answers. `renamed` is not — it
  // would mean the geometry hash called two different meshes identical.
  retriangulated: ['reshaped', 'moved'],
};

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
const EXPECTED_SUCCESSOR = {
  thickened: { stratum: 'footprint', agrees: ['footprint'] },
  swapped: { stratum: 'position', agrees: ['position', 'footprint'] },
};

/** Mutations whose counterpart is a `split` claim: whole = base, pieces = heads. */
const SPLIT_KINDS = new Set(['splitLength']);

/** How far the reported centre displacement may differ from the declared
 *  translation before the engine's `distance` is judged wrong, in metres. */
const DISTANCE_TOLERANCE = 0.01;

function ratio(hits, total) {
  return total === 0 ? null : Number((hits / total).toFixed(6));
}

/**
 * Score one pair.
 *
 * @param key       the answer key from `mutate.mjs`
 * @param matches   `ContentMatch[]` as reported by the matcher under test
 */
export function scorePair(
  key,
  matches,
  { typeOf = new Map(), splitMerges = [], successors = [], hasVolume = new Set() } = {},
) {
  const expected = new Map();
  const kindOf = new Map();
  const classOf = new Map();
  const detailOf = new Map();
  for (const element of key.elements) {
    expected.set(element.base, new Set(element.head));
    kindOf.set(element.base, element.kind);
    classOf.set(element.base, element.class);
    if (element.detail) detailOf.set(element.base, element.detail);
  }
  // Both kinds of head-only element: the 5 m-away clone and the small one
  // planted inside a deleted element's box. A content match onto either is a
  // pair with something that has no counterpart.
  const insertedNearby = new Set(key.insertedNearbyHeadIds ?? []);
  const insertedHeads = new Set([...key.insertedHeadIds, ...insertedNearby]);

  const tally = () => ({ claimed: 0, correct: 0, wrong: 0 });
  const byTier = {};
  const byKind = {};
  const byClass = {};
  const problems = [];
  const falsePairs = { deletedBase: 0, insertedHead: 0, wrongPartner: 0, unkeyed: 0 };
  const recalled = new Set();
  const abstained = new Set();
  const kindAgreed = new Set();
  const kindDisagreed = [];
  const distanceChecked = { checked: 0, agreed: 0 };
  const calibration = { matchedByGeometryHash: [], reportedRenamed: [], recovered: 0, population: 0 };
  const duplicateContainment = { population: 0, contained: 0 };
  const respecifiedControl = { population: 0, reportedRenamed: [], matchedByGeometryOnly: 0 };
  // Content-match claims on bases whose counterpart is a successor or split
  // claim. Not wrong when the head is right — it IS the counterpart — but
  // not what the key predicted either, so it is counted where it can be seen.
  let contentMatchedSuccessorKinds = 0;
  let claimedPairs = 0;
  let correctPairs = 0;

  const bucket = (map, name) => (map[name] ??= tally());

  for (const match of matches) {
    const tier = match.tier ?? 'unknown';
    const baseRefs = match.base.map((entity) => entity.ref);
    const headRefs = match.head.map((entity) => entity.ref);

    if (!PAIRING_KINDS.has(match.kind)) {
      for (const ref of baseRefs) {
        abstained.add(ref);
        if (kindOf.get(ref) === 'duplicated') {
          const wanted = expected.get(ref) ?? new Set();
          if ([...wanted].every((id) => headRefs.includes(id))) duplicateContainment.contained++;
        }
      }
      continue;
    }

    // A pairing match with N per side is the engine's "every bijection here is
    // observationally identical" claim (tier 1, N:N). It is scored as one
    // claim about the SET: correct only if the heads are exactly the true
    // counterparts of the bases. Splitting it into a guessed bijection would
    // credit or blame the engine for a choice it deliberately did not make.
    if (baseRefs.length !== headRefs.length) {
      problems.push(`pairing match with ${baseRefs.length}:${headRefs.length} members`);
      continue;
    }

    const truth = new Set();
    for (const ref of baseRefs) for (const id of expected.get(ref) ?? []) truth.add(id);
    const setCorrect =
      truth.size === headRefs.length && headRefs.every((id) => truth.has(id));

    for (const [position, baseRef] of baseRefs.entries()) {
      claimedPairs++;
      const headRef = headRefs[position];
      const expectedKind = EXPECTED_KIND[kindOf.get(baseRef)];
      const className = classOf.get(baseRef) ?? 'unknown';
      const tierBucket = bucket(byTier, tier);
      const kindBucket = bucket(byKind, kindOf.get(baseRef) ?? 'unkeyed');
      const classBucket = bucket(byClass, className);
      tierBucket.claimed++;
      kindBucket.claimed++;
      classBucket.claimed++;

      if (!expected.has(baseRef)) {
        falsePairs.unkeyed++;
        for (const b of [tierBucket, kindBucket, classBucket]) b.wrong++;
        continue;
      }
      if (!setCorrect) {
        if (kindOf.get(baseRef) === 'deleted') falsePairs.deletedBase++;
        else if (insertedHeads.has(headRef)) falsePairs.insertedHead++;
        else falsePairs.wrongPartner++;
        for (const b of [tierBucket, kindBucket, classBucket]) b.wrong++;
        continue;
      }

      correctPairs++;
      recalled.add(baseRef);
      for (const b of [tierBucket, kindBucket, classBucket]) b.correct++;
      if (EXPECTED_SUCCESSOR[kindOf.get(baseRef)] !== undefined) contentMatchedSuccessorKinds++;
      if (kindOf.get(baseRef) === 'respecified') {
        if (match.kind === 'renamed') respecifiedControl.reportedRenamed.push(baseRef);
        if (tier === 'geometry-only') respecifiedControl.matchedByGeometryOnly++;
      }

      const wanted = expectedKind === undefined ? [] : [].concat(expectedKind);
      if (wanted.includes(match.kind)) kindAgreed.add(baseRef);
      else if (wanted.length > 0) {
        kindDisagreed.push({ base: baseRef, expected: wanted, reported: match.kind });
      }
      if (kindOf.get(baseRef) === 'retriangulated') {
        if (tier === 'geometry-hash') calibration.matchedByGeometryHash.push(baseRef);
        if (match.kind === 'renamed') calibration.reportedRenamed.push(baseRef);
        calibration.recovered++;
      }
      if (kindOf.get(baseRef) === 'moved' && match.distance !== undefined) {
        const declared = detailOf.get(baseRef)?.distanceMetres;
        if (declared !== undefined) {
          distanceChecked.checked++;
          if (Math.abs(match.distance - declared) <= DISTANCE_TOLERANCE) distanceChecked.agreed++;
        }
      }
    }
  }

  // Fixed denominators, straight off the key.
  const populations = {};
  for (const element of key.elements) {
    populations[element.kind] = (populations[element.kind] ?? 0) + 1;
    if (element.kind === 'duplicated') duplicateContainment.population++;
    if (element.kind === 'retriangulated') calibration.population++;
    if (element.kind === 'respecified') respecifiedControl.population++;
  }

  // Head ref → what the key says it is, for the wrong-claim listings.
  const headOrigin = new Map();
  for (const element of key.elements) {
    for (const ref of element.head) headOrigin.set(ref, `${element.kind}:${element.base}`);
  }
  for (const ref of key.insertedHeadIds) headOrigin.set(ref, 'inserted');
  for (const ref of insertedNearby) headOrigin.set(ref, 'insertedNearby');

  const successorScore = scoreSuccessors(key, successors, { expected, kindOf, insertedNearby });
  const splitScore = scoreSplits(key, splitMerges, { hasVolume, kindOf, headOrigin });

  const recallable = key.elements.filter((element) => EXPECTED_KIND[element.kind] !== undefined);
  const recallByKind = {};
  const recallByClass = {};
  for (const element of recallable) {
    const kindRow = (recallByKind[element.kind] ??= { population: 0, recalled: 0, abstained: 0, kindAgreed: 0 });
    const classRow = (recallByClass[element.class] ??= { population: 0, recalled: 0, abstained: 0 });
    kindRow.population++;
    classRow.population++;
    if (recalled.has(element.base)) {
      kindRow.recalled++;
      classRow.recalled++;
    }
    if (abstained.has(element.base)) {
      kindRow.abstained++;
      classRow.abstained++;
    }
    if (kindAgreed.has(element.base)) kindRow.kindAgreed++;
  }

  const finish = (rows) => {
    const out = {};
    for (const [name, row] of Object.entries(rows)) {
      out[name] = {
        ...row,
        precision: ratio(row.correct, row.claimed),
      };
    }
    return out;
  };

  const withRecall = (rows, claims) => {
    const out = {};
    for (const [name, row] of Object.entries(rows)) {
      // The claim COUNTS are copied onto the row, not merely consumed to
      // derive `precision`. Every precision clause — gating and target alike —
      // is guarded by `row.claimed > 0`, so a row without the field made that
      // `undefined > 0`, i.e. false, and SEVEN declared precision floors plus
      // their pre-registered targets never executed. Worse than dead: they
      // were dead SILENTLY, absent from `thresholdsSkipped` too, so
      // thresholds.json read as though they were enforced. A fixture whose own
      // clauses can be inert without saying so is the defect this fixture
      // exists to catch, one level up.
      const claim = claims[name] ?? { claimed: 0, correct: 0, wrong: 0 };
      out[name] = {
        ...row,
        claimed: claim.claimed,
        correct: claim.correct,
        wrong: claim.wrong,
        recall: ratio(row.recalled, row.population),
        precision: ratio(claim.correct, claim.claimed),
        ...(row.kindAgreed !== undefined
          ? { kindAgreement: ratio(row.kindAgreed, row.recalled) }
          : {}),
      };
    }
    return out;
  };

  // WHY the misses, not just how many. A recall number alone cannot
  // distinguish "the engine reported an ambiguous group" (an abstention it is
  // contractually entitled to) from "the engine never mentioned the element at
  // all", and the two point at different code.
  const missed = { abstained: 0, silent: 0, byType: {} };
  const mentioned = new Set([...recalled, ...abstained]);
  for (const element of recallable) {
    if (recalled.has(element.base)) continue;
    if (abstained.has(element.base)) missed.abstained++;
    else if (!mentioned.has(element.base)) missed.silent++;
    // VERBATIM adapter output, deliberately not normalized. The shipped
    // adapter spells IFC2X3 `…STYLE` classes raw-uppercase and everything else
    // PascalCase (see SPEC.md, F3); tidying that here would hide an
    // inconsistency in the thing being measured, which is the opposite of this
    // file's job.
    const type = typeOf.get(element.base) ?? 'unknown';
    missed.byType[type] = (missed.byType[type] ?? 0) + 1;
  }
  missed.byType = Object.fromEntries(
    Object.entries(missed.byType).sort((a, b) => b[1] - a[1]).slice(0, 12),
  );

  return {
    population: key.elements.length,
    populations,
    inserted: key.insertedHeadIds.length,
    overall: {
      claimedPairs,
      correctPairs,
      precision: ratio(correctPairs, claimedPairs),
      recallPopulation: recallable.length,
      recalled: recalled.size,
      recall: ratio(recalled.size, recallable.length),
      abstained: abstained.size,
    },
    falsePairs,
    byTier: finish(byTier),
    byKind: withRecall(recallByKind, byKind),
    byClass: withRecall(recallByClass, byClass),
    calibration: {
      ...calibration,
      recoveredByLowerTiers: ratio(calibration.recovered, calibration.population),
    },
    duplicateContainment: {
      ...duplicateContainment,
      rate: ratio(duplicateContainment.contained, duplicateContainment.population),
    },
    respecifiedControl,
    contentMatchedSuccessorKinds,
    insertedNearby: insertedNearby.size,
    ...successorScore,
    ...splitScore,
    moveDistance: {
      ...distanceChecked,
      agreement: ratio(distanceChecked.agreed, distanceChecked.checked),
    },
    missed,
    kindDisagreements: kindDisagreed.slice(0, 20),
    anomalies: problems.slice(0, 20),
  };
}

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
function scoreSuccessors(key, successors, { expected, kindOf, insertedNearby }) {
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
function scoreSplits(key, splitMerges, { hasVolume, kindOf, headOrigin }) {
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
    const correct =
      truth !== undefined && truth.size === pieces.length && pieces.every((ref) => truth.has(ref));
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

/**
 * Check one pair's scorecard against the PRE-REGISTERED per-pair thresholds.
 *
 * Returns `{ failures, skipped }`. A stratum this model does not populate is
 * SKIPPED rather than failed — one model has no arcs to re-sample, another no
 * geometry-free objects — and the corpus clauses below are what guarantee the
 * stratum exists somewhere and clears its floor in aggregate. Skips are
 * reported, so "everything was skipped" can never read as a pass.
 */
export function checkThresholds(score, thresholds) {
  const failures = [];
  const skipped = [];
  const floor = (label, value, minimum) => {
    if (minimum === undefined) return;
    if (value === null || value === undefined) failures.push(`${label}: no measurement (floor ${minimum})`);
    else if (value < minimum) failures.push(`${label}: ${value} < floor ${minimum}`);
  };
  const ceiling = (label, value, maximum) => {
    if (maximum === undefined) return;
    if (value > maximum) failures.push(`${label}: ${value} > ceiling ${maximum}`);
  };

  floor('overall.precision', score.overall.precision, thresholds.overall?.precision);
  floor('overall.recall', score.overall.recall, thresholds.overall?.recall);

  for (const [name, minimum] of Object.entries(thresholds.byTier?.precision ?? {})) {
    const row = score.byTier[name];
    if (!row || row.claimed === 0) skipped.push(`byTier.${name}.precision (no pairs)`);
    else floor(`byTier.${name}.precision`, row.precision, minimum);
  }
  for (const [name, floors] of Object.entries(thresholds.byKind ?? {})) {
    const row = score.byKind[name];
    if (!row || row.population === 0) {
      skipped.push(`byKind.${name} (population 0)`);
      continue;
    }
    floor(`byKind.${name}.recall`, row.recall, floors.recall);
    // An unevaluable clause SAYS SO. Silently not running is how seven
    // precision floors sat inert while thresholds.json read as if they were
    // enforced; a skip line is the difference between "not applicable here"
    // and "quietly not checked".
    if (row.claimed > 0) floor(`byKind.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`byKind.${name}.precision (no pairs claimed)`);
    if (row.recalled > 0) floor(`byKind.${name}.kindAgreement`, row.kindAgreement, floors.kindAgreement);
    else if (floors.kindAgreement !== undefined) {
      skipped.push(`byKind.${name}.kindAgreement (nothing recalled)`);
    }
  }
  for (const [name, floors] of Object.entries(thresholds.byClass ?? {})) {
    const row = score.byClass[name];
    if (!row || row.population === 0) {
      skipped.push(`byClass.${name} (population 0)`);
      continue;
    }
    floor(`byClass.${name}.recall`, row.recall, floors.recall);
    if (row.claimed > 0) floor(`byClass.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`byClass.${name}.precision (no pairs claimed)`);
  }

  // Successor strata (issue #4955): recall per EXPECTED profile, precision per
  // expected and per REPORTED profile, confidence agreement. Skips are named
  // for the same reason as above.
  for (const [name, floors] of Object.entries(thresholds.bySuccessor ?? {})) {
    const row = score.bySuccessor?.[name];
    if (!row || row.population === 0) {
      skipped.push(`bySuccessor.${name} (population 0)`);
      continue;
    }
    floor(`bySuccessor.${name}.recall`, row.recall, floors.recall);
    if (row.claimed > 0) floor(`bySuccessor.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`bySuccessor.${name}.precision (no claims)`);
    if (row.recalled > 0) floor(`bySuccessor.${name}.kindAgreement`, row.kindAgreement, floors.kindAgreement);
    else if (floors.kindAgreement !== undefined) {
      skipped.push(`bySuccessor.${name}.kindAgreement (nothing recalled)`);
    }
  }
  for (const [name, minimum] of Object.entries(thresholds.bySuccessorConfidence?.precision ?? {})) {
    const row = score.bySuccessorConfidence?.[name];
    if (!row || row.claimed === 0) skipped.push(`bySuccessorConfidence.${name}.precision (no claims)`);
    else floor(`bySuccessorConfidence.${name}.precision`, row.precision, minimum);
  }
  if (thresholds.bySplit) {
    const row = score.bySplit;
    // A model with no split population can still receive a WRONG claim, and
    // a per-pair precision floor over one claim would have to be 0 to be
    // green anywhere. So it is skipped here, NAMED with the claim count, and
    // `corpus.bySplit.precision` below is what counts that claim.
    if (!row || row.population === 0) {
      const note = row?.claimed ? `, ${row.claimed} claim(s) counted by corpus.bySplit.precision` : '';
      skipped.push(`bySplit (population 0${note})`);
    } else {
      floor('bySplit.recall', row.recall, thresholds.bySplit.recall);
      if (row.claimed > 0) floor('bySplit.precision', row.precision, thresholds.bySplit.precision);
      else if (thresholds.bySplit.precision !== undefined) skipped.push('bySplit.precision (no claims)');
      if (row.recalled > 0) {
        floor('bySplit.kindAgreement', row.kindAgreement, thresholds.bySplit.kindAgreement);
      } else if (thresholds.bySplit.kindAgreement !== undefined) {
        skipped.push('bySplit.kindAgreement (nothing recalled)');
      }
    }
  }

  const negative = thresholds.negativeControls ?? {};
  ceiling('falsePairs.deletedBase', score.falsePairs.deletedBase, negative.deletedBase);
  ceiling('falsePairs.insertedHead', score.falsePairs.insertedHead, negative.insertedHead);
  ceiling('falsePairs.wrongPartner', score.falsePairs.wrongPartner, negative.wrongPartner);
  ceiling('falsePairs.unkeyed', score.falsePairs.unkeyed, negative.unkeyed);
  ceiling(
    'falseSuccessors.insertedNearby',
    score.falseSuccessors?.insertedNearby ?? 0,
    negative.successorInsertedNearby,
  );
  ceiling(
    'falseSuccessors.neighbourSuccessor',
    score.falseSuccessors?.neighbourSuccessor ?? 0,
    negative.neighbourSuccessor,
  );
  ceiling(
    'respecifiedControl.reportedRenamed',
    score.respecifiedControl?.reportedRenamed.length ?? 0,
    negative.respecifiedReportedRenamed,
  );

  const cal = thresholds.calibration ?? {};
  ceiling(
    'calibration.matchedByGeometryHash',
    score.calibration.matchedByGeometryHash.length,
    cal.matchedByGeometryHash,
  );
  ceiling('calibration.reportedRenamed', score.calibration.reportedRenamed.length, cal.reportedRenamed);

  if (score.anomalies.length > 0) {
    failures.push(`engine anomalies: ${score.anomalies.join('; ')}`);
  }
  return { failures, skipped };
}

/**
 * Check the corpus as a whole: does the exam ask its questions at all, and do
 * the rates whose stratum a single model may not populate hold in aggregate?
 *
 * The population floors are the anti-vacuity clauses. Without them a mutation
 * that silently stopped being applied — an eligibility predicate that now
 * matches nothing, a model swapped for one without arcs — would show up as a
 * *green* run over a smaller exam, which is exactly the failure mode this
 * whole fixture exists to make impossible.
 */
export function checkCorpusThresholds(scores, thresholds) {
  const failures = [];
  const sum = (pick) => scores.reduce((total, score) => total + (pick(score) ?? 0), 0);

  for (const [kind, minimum] of Object.entries(thresholds.populations ?? {})) {
    const total =
      kind === 'curved'
        ? sum((score) => score.byClass.curved?.population)
        : kind === 'inserted'
          ? sum((score) => score.inserted)
          : kind === 'insertedNearby'
            ? sum((score) => score.insertedNearby)
            : sum((score) => score.populations[kind]);
    if (total < minimum) failures.push(`corpus.populations.${kind}: ${total} < floor ${minimum}`);
  }
  for (const [tier, minimum] of Object.entries(thresholds.tierPairs ?? {})) {
    const total = sum((score) => score.byTier[tier]?.claimed);
    if (total < minimum) failures.push(`corpus.tierPairs.${tier}: ${total} < floor ${minimum}`);
  }

  const rate = (label, hits, total, minimum) => {
    if (minimum === undefined) return;
    if (total === 0) failures.push(`${label}: nothing measured (floor ${minimum})`);
    else if (hits / total < minimum) {
      failures.push(`${label}: ${(hits / total).toFixed(4)} < floor ${minimum}`);
    }
  };
  rate(
    'corpus.calibration.recoveredByLowerTiers',
    sum((score) => score.calibration.recovered),
    sum((score) => score.calibration.population),
    thresholds.calibration?.recoveredByLowerTiers,
  );
  rate(
    'corpus.duplicateContainment.rate',
    sum((score) => score.duplicateContainment.contained),
    sum((score) => score.duplicateContainment.population),
    thresholds.duplicateContainment?.rate,
  );
  rate(
    'corpus.moveDistance.agreement',
    sum((score) => score.moveDistance.agreed),
    sum((score) => score.moveDistance.checked),
    thresholds.moveDistance?.agreement,
  );
  // The claim strata in aggregate (issue #4955). Per-pair floors skip a model
  // whose population is 0, so a wrong split claim on such a model — AC20's
  // duplicated stair, finding F5 — is only ever counted here; and the
  // `position` profile's recall is a corpus question because one model's
  // unnamed building (F4) switches the profile off there entirely.
  rate(
    'corpus.bySplit.precision',
    sum((score) => score.bySplit?.correct),
    sum((score) => score.bySplit?.claimed),
    thresholds.bySplit?.precision,
  );
  rate(
    'corpus.bySplit.recall',
    sum((score) => score.bySplit?.recalled),
    sum((score) => score.bySplit?.population),
    thresholds.bySplit?.recall,
  );
  for (const [name, floors] of Object.entries(thresholds.bySuccessor ?? {})) {
    rate(
      `corpus.bySuccessor.${name}.recall`,
      sum((score) => score.bySuccessor?.[name]?.recalled),
      sum((score) => score.bySuccessor?.[name]?.population),
      floors.recall,
    );
    rate(
      `corpus.bySuccessor.${name}.precision`,
      sum((score) => score.bySuccessor?.[name]?.correct),
      sum((score) => score.bySuccessor?.[name]?.claimed),
      floors.precision,
    );
  }
  // Corpus-TOTAL ceilings on the successor negative controls: a per-pair
  // ceiling raised to one model's measured count would let every other
  // model climb to it unnoticed.
  const totalCeiling = (label, total, maximum) => {
    if (maximum === undefined) return;
    if (total > maximum) failures.push(`${label}: ${total} > ceiling ${maximum}`);
  };
  totalCeiling(
    'corpus.falseSuccessors.insertedNearby',
    sum((score) => score.falseSuccessors?.insertedNearby),
    thresholds.falseSuccessors?.insertedNearby,
  );
  totalCeiling(
    'corpus.falseSuccessors.neighbourSuccessor',
    sum((score) => score.falseSuccessors?.neighbourSuccessor),
    thresholds.falseSuccessors?.neighbourSuccessor,
  );
  return failures;
}

/**
 * Corpus-level strata measuring BELOW (or, for ceilings, above) their
 * pre-registered target — reported, never gating, like {@link targetGaps}.
 */
export function corpusTargetGaps(scores, targets) {
  const gaps = [];
  const sum = (pick) => scores.reduce((total, score) => total + (pick(score) ?? 0), 0);
  const compare = (label, hits, total, target) => {
    if (target === undefined || total === 0) return;
    const value = Number((hits / total).toFixed(6));
    if (value < target) gaps.push(`${label}: ${value} < target ${target}`);
  };
  compare(
    'corpus.bySplit.precision',
    sum((score) => score.bySplit?.correct),
    sum((score) => score.bySplit?.claimed),
    targets.bySplit?.precision,
  );
  compare(
    'corpus.bySplit.recall',
    sum((score) => score.bySplit?.recalled),
    sum((score) => score.bySplit?.population),
    targets.bySplit?.recall,
  );
  for (const [name, wanted] of Object.entries(targets.bySuccessor ?? {})) {
    compare(
      `corpus.bySuccessor.${name}.recall`,
      sum((score) => score.bySuccessor?.[name]?.recalled),
      sum((score) => score.bySuccessor?.[name]?.population),
      wanted.recall,
    );
  }
  const exceed = (label, total, target) => {
    if (target !== undefined && total > target) gaps.push(`${label}: ${total} > target ${target}`);
  };
  exceed(
    'corpus.falseSuccessors.insertedNearby',
    sum((score) => score.falseSuccessors?.insertedNearby),
    targets.negativeControls?.successorInsertedNearby,
  );
  exceed(
    'corpus.falseSuccessors.neighbourSuccessor',
    sum((score) => score.falseSuccessors?.neighbourSuccessor),
    targets.negativeControls?.neighbourSuccessor,
  );
  return gaps;
}

/**
 * Strata measuring BELOW their pre-registered target — reported, never gating.
 *
 * The gating floors are a ratchet against regression; these are the original
 * pre-registration, and the difference between them is a standing debt. A
 * fixture that quietly replaced its aspiration with its measurement would be
 * green and would have forgotten what it was for, which is the same failure as
 * a check that cannot fail, one level up.
 */
export function targetGaps(score, targets) {
  const gaps = [];
  const compare = (label, value, target) => {
    if (target === undefined || value === null || value === undefined) return;
    if (value < target) gaps.push(`${label}: ${value} < target ${target}`);
  };

  compare('overall.precision', score.overall.precision, targets.overall?.precision);
  compare('overall.recall', score.overall.recall, targets.overall?.recall);
  for (const [name, target] of Object.entries(targets.byTier?.precision ?? {})) {
    const row = score.byTier[name];
    if (row && row.claimed > 0) compare(`byTier.${name}.precision`, row.precision, target);
  }
  for (const [name, wanted] of Object.entries(targets.byKind ?? {})) {
    const row = score.byKind[name];
    if (!row || row.population === 0) continue;
    compare(`byKind.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`byKind.${name}.precision`, row.precision, wanted.precision);
    if (row.recalled > 0) {
      compare(`byKind.${name}.kindAgreement`, row.kindAgreement, wanted.kindAgreement);
    }
  }
  for (const [name, wanted] of Object.entries(targets.byClass ?? {})) {
    const row = score.byClass[name];
    if (!row || row.population === 0) continue;
    compare(`byClass.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`byClass.${name}.precision`, row.precision, wanted.precision);
  }
  for (const [name, wanted] of Object.entries(targets.bySuccessor ?? {})) {
    const row = score.bySuccessor?.[name];
    if (!row || row.population === 0) continue;
    compare(`bySuccessor.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`bySuccessor.${name}.precision`, row.precision, wanted.precision);
    if (row.recalled > 0) {
      compare(`bySuccessor.${name}.kindAgreement`, row.kindAgreement, wanted.kindAgreement);
    }
  }
  for (const [name, target] of Object.entries(targets.bySuccessorConfidence?.precision ?? {})) {
    const row = score.bySuccessorConfidence?.[name];
    if (row && row.claimed > 0) compare(`bySuccessorConfidence.${name}.precision`, row.precision, target);
  }
  if (targets.bySplit && score.bySplit && score.bySplit.population > 0) {
    compare('bySplit.recall', score.bySplit.recall, targets.bySplit.recall);
    if (score.bySplit.claimed > 0) {
      compare('bySplit.precision', score.bySplit.precision, targets.bySplit.precision);
    }
    if (score.bySplit.recalled > 0) {
      compare('bySplit.kindAgreement', score.bySplit.kindAgreement, targets.bySplit.kindAgreement);
    }
  }
  // Ceilings have targets too: a negative control whose gating ceiling had to
  // be raised to the measured count still reports the distance to zero.
  const exceed = (label, value, target) => {
    if (target === undefined || value === undefined) return;
    if (value > target) gaps.push(`${label}: ${value} > target ${target}`);
  };
  const negative = targets.negativeControls ?? {};
  exceed(
    'falseSuccessors.insertedNearby',
    score.falseSuccessors?.insertedNearby,
    negative.successorInsertedNearby,
  );
  exceed(
    'falseSuccessors.neighbourSuccessor',
    score.falseSuccessors?.neighbourSuccessor,
    negative.neighbourSuccessor,
  );
  exceed(
    'respecifiedControl.reportedRenamed',
    score.respecifiedControl?.reportedRenamed.length,
    negative.respecifiedReportedRenamed,
  );
  return gaps;
}
