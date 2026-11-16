/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How each flood-check outcome is shown: its colour in the viewport, its order
 * in the summary, its label key. The two conservative outcomes are red and
 * orange so they stand out; nothing is green, because no outcome of this
 * screening says an element is safe. "No runoff mapped" is a neutral grey like
 * "Not established": the publisher states that areas shown unaffected may
 * still be affected.
 */

import type { FloodCheckResult, Outcome } from '@ifc-lite/flood-check';
import type { RGBA } from '@/store/slices/overlaySlice';

/** Summary order: most severe first. */
export const OUTCOME_ORDER: readonly Outcome[] = [
  'exposed', 'open-ended-class', 'within-class-range', 'above-mapped-class-range', 'no-runoff-mapped', 'unclassified',
];

export const OUTCOME_COLOURS: Readonly<Record<Outcome, RGBA>> = {
  exposed: [0.89, 0.02, 0.07, 1],
  'open-ended-class': [0.96, 0.42, 0.05, 1],
  'within-class-range': [0.96, 0.75, 0.12, 1],
  'above-mapped-class-range': [0.33, 0.52, 0.80, 1],
  'no-runoff-mapped': [0.70, 0.71, 0.72, 1],
  unclassified: [0.52, 0.52, 0.56, 1],
};

export const OUTCOME_LABEL_KEY = {
  exposed: 'floodCheck.outcome.exposed',
  'open-ended-class': 'floodCheck.outcome.openEnded',
  'within-class-range': 'floodCheck.outcome.withinRange',
  'above-mapped-class-range': 'floodCheck.outcome.aboveRange',
  'no-runoff-mapped': 'floodCheck.outcome.noRunoffMapped',
  unclassified: 'floodCheck.outcome.unclassified',
} as const satisfies Record<Outcome, string>;

/** CSS colour of an outcome, for swatches and badges. */
export function outcomeCss(outcome: Outcome): string {
  const [r, g, b] = OUTCOME_COLOURS[outcome];
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/**
 * Viewport colour per checked element, keyed by global id. An element whose
 * outcome reports through its door or window (an opening it fills) is the
 * candidate's own express id, so every result colours exactly one entity.
 */
export function floodVerdictOverrides(
  result: Pick<FloodCheckResult, 'results'>,
  toGlobalId: (expressId: number) => number,
): Map<number, RGBA> {
  const colours = new Map<number, RGBA>();
  for (const entry of result.results) colours.set(toGlobalId(entry.candidate.expressId), OUTCOME_COLOURS[entry.outcome]);
  return colours;
}

/** The text of a localized package string in the viewer's locale (German for `de`, else English). */
export function localized(text: { en: string; de: string }, locale: string): string {
  return locale === 'de' ? text.de : text.en;
}
