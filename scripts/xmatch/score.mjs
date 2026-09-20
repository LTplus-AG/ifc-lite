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

import { EXPECTED_SUCCESSOR, scoreMerges, scoreSplits, scoreSuccessors } from './score-claims.mjs';
export { checkCorpusThresholds, checkThresholds, corpusTargetGaps, targetGaps } from './score-thresholds.mjs';

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

/** How far the reported centre displacement may differ from the declared
 *  translation before the engine's `distance` is judged wrong, in metres. */
const DISTANCE_TOLERANCE = 0.01;

export function ratio(hits, total) {
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
      // A `merged` base (issue #4989 review) exists ONLY for the split/merge
      // claim stage — a whole-vs-half identity is exactly the claim the
      // CONTENT matcher must never make. `setCorrect` alone cannot see that
      // for the PRIMARY's row: its `expected` head is literally itself
      // (`{ base: primaryId, head: [primaryId] }` — the head keeps the same
      // id, just renamed), so a 1:1 content match pairing it with itself
      // reads as trivially "correct" by set equality even though it is the
      // one thing `merged` must never be recovered by. Same for the
      // base-side clone's row, on the same theory as `splitLength`'s two
      // heads (there the SIZE mismatch alone refuses a 1:1 pairing; here it
      // would not, so it is refused explicitly).
      const mergedIdentityClaim = kindOf.get(baseRef) === 'merged';
      if (!setCorrect || mergedIdentityClaim) {
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
  const mergeScore = scoreMerges(key, splitMerges, { hasVolume, kindOf, headOrigin });

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
    ...mergeScore,
    moveDistance: {
      ...distanceChecked,
      agreement: ratio(distanceChecked.agreed, distanceChecked.checked),
    },
    missed,
    kindDisagreements: kindDisagreed.slice(0, 20),
    anomalies: problems.slice(0, 20),
  };
}
