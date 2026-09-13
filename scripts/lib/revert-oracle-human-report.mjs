/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { SURGICAL_ADVICE } from './revert-oracle.mjs';

export function printHumanReport(result, observer, narrowed, log = console.log) {
  const banner = {
    OBSERVED: '  ✔ OBSERVED',
    UNOBSERVED: '  ✘ UNOBSERVED  <-- FINDING',
    INCONCLUSIVE: '  ? INCONCLUSIVE  <-- ORACLE CAPABILITY GAP',
    'BASELINE-BROKEN': '  ! BASELINE-BROKEN  <-- ORACLE COULD NOT MEASURE',
  }[result.verdict];

  log('\n' + '='.repeat(78));
  log(banner);
  log('='.repeat(78));
  log(`  observer:  ${observer}`);
  log(`  reverted:  ${result.prodPaths.join('\n             ')}`);
  log(`  tests run: ${result.testPaths.join('\n             ')}`);
  log(`  baseline:  ${result.baseline.kind} — ${result.baseline.passed ?? '?'} passed / ${result.baseline.total ?? '?'} collected`);
  log(`  reverted:  ${result.revertedRun.kind} — ${result.revertedRun.passed ?? '?'} passed, ${result.revertedRun.failed ?? '?'} failed / ${result.revertedRun.total ?? '?'} collected`);
  log(`\n  ${result.reason}`);
  if (result.advice) log(`\n  NEXT: ${result.advice}`);
  if (result.verdict === 'OBSERVED' && result.prodPaths.length > 1 && !narrowed) {
    log(
      `\n  NOTE: ${result.prodPaths.length} production files were reverted together, so this tick may be ` +
        'earned by one of them. Re-run with --only <path> per file to find the unobserved ones.',
    );
  }
  if (result.verdict === 'INCONCLUSIVE' && result.advice !== SURGICAL_ADVICE) {
    log(`\n  ALSO: ${SURGICAL_ADVICE}`);
  }
  log('');
}
