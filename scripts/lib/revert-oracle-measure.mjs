/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The measurement sequence of the revert oracle: baseline, revert, re-run.
 * Moved out of `check-test-revert-oracle.mjs`, which sits at its module-size
 * budget, when #6267 added the browser observer.
 *
 * Browser plans are the expensive ones (a viewer build and a real browser per
 * side), so they run ONLY when the cheap runners produced no witness. That
 * decision needs the cheap reverted results, which exist only after the
 * revert, so the browser sequence is: reverted run while production is still
 * reverted, then a verified restore, then the baseline on the restored tree,
 * then a check that the baseline build left the tree clean. Each side builds
 * from the tree it is on, so the order does not change what either measures.
 */

import { runPlan } from './revert-oracle-run-plan.mjs';
import { runBrowserPlan } from './revert-oracle-browser-run.mjs';
import { buildExecutionLedger, ledgerVerdict } from './revert-oracle-ledger.mjs';
import { OBSERVED } from './revert-oracle.mjs';

/**
 * @param {{ plans: object[], root: string, revert: () => void, restore: () => void, assertClean: () => void, log?: Function }} args
 *   `revert` reverse-applies production, `restore` forward-applies it and
 *   verifies the tree; both abort the process on failure.
 * @returns {{ plans: object[], baselineResults: object[], revertedResults: object[], deferred: object[] }}
 */
export function measure({ plans, root, revert, restore, assertClean, log = console.log }) {
  const cheap = plans.filter((plan) => !plan.browser);
  const browser = plans.filter((plan) => plan.browser);

  log('\n[1/3] baseline: running the branch\'s own tests, unmodified');
  if (cheap.length === 0) log('  (no node/cargo/pytest/typecheck plan; only the browser observer below can witness)');
  const baselineResults = cheap.map((plan) => runPlan(plan, root, 'baseline', log));
  log('\n[2/3] reverting the production change');
  revert();
  log('\n[3/3] re-running the same tests with production reverted');
  const revertedResults = cheap.map((plan) => runPlan(plan, root, 'reverted', log));

  if (browser.length === 0) return { plans: cheap, baselineResults, revertedResults, deferred: [] };
  const witnessed = cheap.length > 0 && ledgerVerdict(buildExecutionLedger({ plans: cheap, baselineResults, revertedResults })).verdict === OBSERVED;
  if (witnessed) {
    log(`\n[browser] not run: a changed non-browser test already observed the revert; ${browser.length} Playwright spec(s) skipped to bound CI time`);
    return { plans: cheap, baselineResults, revertedResults, deferred: browser };
  }

  log('\n[browser 1/2] reverted: building the viewer and running the changed Playwright spec(s) with production still reverted');
  const browserReverted = browser.map((plan) => runBrowserPlan(plan, root, 'reverted', log));
  log('\n[browser 2/2] baseline: restoring production, rebuilding, and running the same spec(s)');
  restore();
  const browserBaseline = browser.map((plan) => runBrowserPlan(plan, root, 'baseline', log));
  assertClean();
  return {
    plans: [...cheap, ...browser],
    baselineResults: [...baselineResults, ...browserBaseline],
    revertedResults: [...revertedResults, ...browserReverted],
    deferred: [],
  };
}
