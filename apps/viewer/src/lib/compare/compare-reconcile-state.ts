/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Computing a reconciliation (#6921). Kept apart from `compare-analysis-state`
 * so the assistant's eager comparison adapter, which only reads impact and the
 * saved outcome, does not pull the reconcilers into the startup bundle.
 */

import { reconcileContextOf, type State } from './compare-analysis-state';
import { reconcileRuns } from './run-reconcile';
import type { CapturedRun, SavedReconciliation } from './run-reconcile-types';

/** Reconcile two captured runs against the current comparison, keeping what a later staleness check needs. */
export function savedReconciliationOf(state: State, base: CapturedRun, head: CapturedRun): SavedReconciliation | null {
  if (!state.compareResult) return null;
  return { outcome: reconcileRuns(base, head, reconcileContextOf(state)), comparison: state.compareResult,
    stamps: base === head ? [base.stamp] : [base.stamp, head.stamp] };
}
