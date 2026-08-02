#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 PRE-REGISTRATION. Written and committed BEFORE the measurement.
 *
 * This module holds two things and nothing else: the PREDICTION and the
 * ADMISSIBILITY BAR. It performs no measurement, imports nothing that does,
 * and is the only place either is stated. `run.mjs` imports it and is not
 * permitted to restate a threshold in its own body -- so a result cannot be
 * accompanied by a bar that was quietly adjusted to fit it.
 *
 * The reason for the separation is the failure mode this bet is most exposed
 * to. B5.1 adjudicates B2.1, and both plausible outcomes are publishable: "the
 * spatial rule earns its place on real data" and "it does not". A bet with two
 * publishable outcomes and no pre-registered prediction is a bet that reports
 * whatever came out and calls it the finding. Registering first makes exactly
 * one of the two outcomes a surprise, which is the only condition under which
 * the measurement is worth more than its own arithmetic.
 *
 * PROVENANCE OF THE PREDICTION. It is not a guess made up for this file. It is
 * B4.2's own derived-cut sensitivity grid, extended to the population B5.1 was
 * commissioned to measure. B4.2 found the spatial rule's true catches collapse
 * from nine to zero-or-one once the cut is DERIVED rather than stored, and
 * named the survivor: an opening added into an element another client removes,
 * which is IfcRelVoidsElement referential integrity and needs no geometry to
 * catch. This bet predicts that result holds on the population, and registers
 * the read-set claim as a second, separately falsifiable clause.
 */

export const REGISTERED_ON = '2026-08-02';

/* ------------------------------------------------------------------ */
/* The prediction                                                        */
/* ------------------------------------------------------------------ */

export const PREDICTION = {
  id: 'b51-p1',
  registeredOn: REGISTERED_ON,
  statement:
    'Under the cut semantics this repository actually implements, which is derived and not the ' +
    'stored lazy cut the published headline was measured in, the spatial rule of the conflict ' +
    'predicate has a true-catch count of zero or one. The residual hazard is referential ' +
    'integrity of the hosting relation, catchable by a read-set check over relationship targets ' +
    'with no geometry at all.',
  /**
   * Each clause is scored independently and each can fail on its own. A
   * prediction whose clauses can only be graded as a bundle is one claim
   * wearing three hats.
   */
  clauses: [
    {
      id: 'b51-p1a',
      label: 'spatial-true-catch-collapses',
      statement:
        'Spatial-only true conflicts per one thousand schedules, under derived cuts, is at most ' +
        'one, averaged over independent seeds.',
      // Scored against measurements.derivedCells; see run.mjs gradeClauseA.
      bar: { metric: 'spatialOnlyTrueConflictsPerThousand', comparator: 'lte', value: 1 },
    },
    {
      id: 'b51-p1b',
      label: 'lazy-cell-is-the-outlier',
      statement:
        'The same count under the stored lazy cut is strictly greater, so the published nine is ' +
        'a property of that cell and not of the predicate.',
      bar: { metric: 'lazyMinusDerivedPerThousand', comparator: 'gt', value: 0 },
    },
    {
      id: 'b51-p1c',
      label: 'read-set-substitutes-for-geometry',
      statement:
        'A predicate of structural overlap plus a read-set check over hosting targets, with the ' +
        'spatial rule deleted, admits no more unsound auto-merges than the full predicate does.',
      bar: { metric: 'readSetUnsoundMinusFullUnsound', comparator: 'lte', value: 0 },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* The admissibility bar                                                 */
/* ------------------------------------------------------------------ */

/**
 * WHAT THIS IS FOR. B5.1's exam is "false-conflict rate on real traces". The
 * word doing the work is "real", and it has no defence unless a bar is fixed
 * before the corpus is counted. Without one, whatever turns up gets quoted as
 * real traces: three demo rooms replayed by one developer on one afternoon
 * would satisfy the sentence and adjudicate nothing.
 *
 * Every threshold below is a floor for the run to COUNT AS AN ADJUDICATION of
 * B2.1. Failing the bar is not a failed bet -- it is a measurement that is not
 * entitled to the word. The distinction is the whole point of registering it.
 */
export const ADMISSIBILITY = {
  id: 'b51-admissibility',
  registeredOn: REGISTERED_ON,
  purpose:
    'Thresholds a trace corpus must clear before a false-conflict rate measured on it may be ' +
    'described as a real-trace rate, or used to adjudicate the open finding.',
  criteria: [
    {
      id: 'a1',
      label: 'distinct-sessions',
      statement: 'At least thirty distinct collaboration sessions.',
      rationale:
        'The exam bar is twenty percent. A binomial proportion measured on fewer than thirty ' +
        'trials has a Wilson interval wider than the bar it is being compared to, so a smaller ' +
        'corpus cannot separate pass from fail whatever it reports.',
      bar: { metric: 'distinctSessions', comparator: 'gte', value: 30 },
    },
    {
      id: 'a2',
      label: 'concurrent-editors',
      statement:
        'At least ten sessions carrying two or more concurrent editors, since a single-editor ' +
        'session cannot produce a merge conflict of any kind.',
      rationale:
        'The scored event is a cross-client op pair. Sessions with one writer contribute zero ' +
        'such pairs and inflate the denominator without informing the numerator.',
      bar: { metric: 'multiEditorSessions', comparator: 'gte', value: 10 },
    },
    {
      id: 'a3',
      label: 'op-vocabulary-coverage',
      statement:
        'The corpus must carry every one of the four op kinds the battery scores, namely an ' +
        'attribute set, a geometry replace, an entity add and an entity remove.',
      rationale:
        'Ground truth is order-sensitivity of the applied state. A corpus missing entity remove ' +
        'cannot produce a delete-versus-modify conflict, which is the class that dominates the ' +
        'true conflicts in the synthetic battery, so its false-conflict rate is measured on a ' +
        'different distribution and is not comparable to the bar.',
      bar: { metric: 'opKindsCovered', comparator: 'gte', value: 4 },
    },
    {
      id: 'a4',
      label: 'hosting-present',
      statement:
        'At least one session containing a hosting relation, that is an opening cut into a host, ' +
        'since that relation is the only mechanism by which the spatial rule can fire truthfully.',
      rationale:
        'Clause b51-p1a is about the spatial rule. A corpus with no hosting relation cannot ' +
        'falsify it in either direction and would let a zero be read as a result when it is an ' +
        'absence of the phenomenon.',
      bar: { metric: 'sessionsWithHosting', comparator: 'gte', value: 1 },
    },
    {
      id: 'a5',
      label: 'independent-authorship',
      statement:
        'The sessions must originate from at least three distinct deployments or teams that are ' +
        'not this program.',
      rationale:
        'This is the external-validity clause of the phase. A corpus authored by the same people ' +
        'who wrote the predicate is a synthetic corpus with a longer commit history.',
      bar: { metric: 'independentOrigins', comparator: 'gte', value: 3 },
    },
    {
      id: 'a6',
      label: 'semantic-op-recovery',
      statement:
        'Each record must resolve to a target and a value, so that a footprint can be computed ' +
        'from it without guessing.',
      rationale:
        'A transport-level record, that is one carrying only a message kind and a payload hash, ' +
        'admits no footprint and therefore no conflict verdict. Coverage here is the fraction of ' +
        'the four scored op kinds that the record type can express at all, and it is separate ' +
        'from a3, which asks whether the corpus happens to contain them.',
      bar: { metric: 'recordTypeExpressesOpKinds', comparator: 'gte', value: 4 },
    },
  ],
};

/** Comparators, one place, so grading cannot drift from registration. */
export function satisfies(comparator, actual, bar) {
  switch (comparator) {
    case 'gte':
      return actual >= bar;
    case 'gt':
      return actual > bar;
    case 'lte':
      return actual <= bar;
    case 'lt':
      return actual < bar;
    default:
      throw new Error(`prereg: unknown comparator ${JSON.stringify(comparator)}`);
  }
}

/** The plan's own M4 kill bar, restated once so run.mjs never inlines it. */
export const KILL_BAR_FALSE_CONFLICT_RATE = 0.2;
