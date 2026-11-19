/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which features this page shows. `isFeatureEnabled(id)` is the whole
 * interface: a caller asks about one catalogue id and learns nothing about
 * where the answer comes from.
 *
 * The answer is fixed for the lifetime of the page. `applyRuntimeConfig`
 * applies the host's configuration once, before the first render; with none,
 * every feature is on and the viewer behaves as it always has.
 *
 * What is gated so far: product analytics are not started, the hosting
 * platform's analytics script is not injected, and the privacy notice is not
 * shown. A tool, panel or command that is off is not offered, cannot be
 * opened by any path, and its shortcuts are not registered; a panel that is
 * off is never rendered, so its lazy chunk is not requested.
 * Editing switched off is refused where edit mode is entered and where a
 * change is committed; extensions switched off are not started; third-party
 * services switched off are not contacted.
 *
 * PRESENTATION, NOT PROTECTION. Nothing here stops a person with the
 * browser's developer tools from reaching code that shipped in the bundle.
 * Whatever must not happen (reading a model, writing one, calling a paid
 * service) has to be refused by the server that owns it.
 */

import { FEATURE_CATALOGUE, type FeatureId } from './catalogue';

export type { FeatureId } from './catalogue';

/** The `features` member of a `ViewerRuntimeConfig`. */
export interface FeatureSelection {
  readonly default: 'all' | 'none';
  /** Read when `default` is `'none'`. */
  readonly enable?: readonly string[];
  /** Read when `default` is `'all'`. */
  readonly disable?: readonly string[];
}

let disabled: ReadonlySet<FeatureId> = new Set();
let applied = false;
const asked = new Set<FeatureId>();

/**
 * The catalogue ids a selection switches off. Ids the catalogue does not
 * list are dropped: a config written for a newer viewer must not break an
 * older one, and it cannot switch off something that is not switchable.
 */
export function disabledFeatures(selection: FeatureSelection | undefined): ReadonlySet<FeatureId> {
  const off = new Set<FeatureId>();
  if (!selection) return off;
  const none = selection.default === 'none';
  const listed = new Set(none ? selection.enable ?? [] : selection.disable ?? []);
  // Under 'none' a feature is off unless listed; under 'all' it is off when listed.
  for (const { id } of FEATURE_CATALOGUE) if (none !== listed.has(id)) off.add(id);
  return off;
}

/**
 * Fix the feature set for this page. Called once, by `applyRuntimeConfig`.
 *
 * A gate that ran before this call answered "on" for a feature the host may
 * have switched off, so that is an error here instead of a quietly leaked
 * surface: a module must not ask at import time.
 */
export function applyFeatureSelection(selection: FeatureSelection | undefined): void {
  if (applied) throw new Error('The viewer feature set is already fixed for this page');
  if (asked.size > 0) {
    throw new Error(`Feature gates ran before the viewer configuration was applied: ${[...asked].join(', ')}`);
  }
  disabled = disabledFeatures(selection);
  applied = true;
}

export function isFeatureEnabled(id: FeatureId): boolean {
  asked.add(id);
  return !disabled.has(id);
}

/**
 * Test seam: replace the feature set and forget what was asked. With a
 * selection the page counts as configured; with none it returns to the state
 * a fresh module starts in (everything on, not yet configured).
 */
export function resetFeaturesForTest(selection?: FeatureSelection): void {
  disabled = disabledFeatures(selection);
  applied = selection !== undefined;
  asked.clear();
}

/** Test seam: every id a gate has asked about since the last reset. */
export function featuresAskedForTest(): ReadonlySet<FeatureId> {
  return asked;
}
