/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pick sequence of a two-point align (#11505) as plain data, so the step
 * order, the role each step needs and the "is it solvable yet" question are
 * decided here and not inside a React effect.
 *
 * Roles are the ones the Reposition pick machinery already has: `source` picks
 * land on the moving models, `target` picks on the reference model. A and B are
 * source picks, A' and B' target picks, in the order A, A', B, B'.
 */
import type { Translation } from './translation.js';
import { alignTwoPoints, type TwoPointAlignRefusal, type TwoPointAlignResult } from './two-point-align.js';

export type AlignStep = 'a' | 'aPrime' | 'b' | 'bPrime';
export const ALIGN_STEPS: readonly AlignStep[] = ['a', 'aPrime', 'b', 'bPrime'];

export type AlignPoints = Readonly<Partial<Record<AlignStep, Translation>>>;

/** The first step still without a point, or `null` once all four are picked. */
export function nextAlignStep(points: AlignPoints): AlignStep | null {
  return ALIGN_STEPS.find((step) => points[step] === undefined) ?? null;
}

export function roleForAlignStep(step: AlignStep | null): 'source' | 'target' | null {
  if (step === null) return null;
  return step === 'a' || step === 'b' ? 'source' : 'target';
}

/** Records `point` for the current step. A pick for any other role is refused
 * (null) rather than filed under the wrong step. */
export function recordAlignPick(points: AlignPoints, role: 'source' | 'target', point: Translation): AlignPoints | null {
  const step = nextAlignStep(points);
  if (step === null || roleForAlignStep(step) !== role) return null;
  return { ...points, [step]: [point[0], point[1], point[2]] as Translation };
}

/** The solution once all four points exist, else null (nothing to preview yet). */
export function solveAlignPoints(points: AlignPoints): TwoPointAlignResult | null {
  const { a, aPrime, b, bPrime } = points;
  if (!a || !aPrime || !b || !bPrime) return null;
  return alignTwoPoints({ a, b, aPrime, bPrime });
}

export const ALIGN_REFUSAL_MESSAGES: Readonly<Record<TwoPointAlignRefusal, string>> = {
  'non-finite': 'A picked point is not a finite coordinate. Pick the points again.',
  'moving-pair-degenerate': 'A and B are at the same plan position. Pick B further from A on the moving models.',
  'reference-pair-degenerate': 'A′ and B′ are at the same plan position. Pick B′ further from A′ on the reference model.',
};
