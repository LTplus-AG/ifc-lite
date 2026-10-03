/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export function requireBuildCompletion(receipt, refusal) {
  if (refusal || receipt.exit !== 0 || receipt.cleanup.status !== 'complete'
    || receipt.logFlush.status !== 'complete' || receipt.pipeTailCertified === false
    || receipt.abortCleanup?.status === 'refused') throw new Error(refusal ?? 'build/cleanup/log refused');
}
export function requireCohortCompletion(report, refusal) {
  if (refusal || report.ownedCleanup.status !== 'complete'
    || report.serverCleanup.some(item => item.status !== 'complete' || item.serverFault)
    || report.samples.length !== 56 || report.samples.some(item => item.status !== 'complete')
    || report.pairs.length !== 28 || report.pairs.some(item => item.status !== 'complete')
    || report.finalInputVerification !== 'complete') throw new Error(refusal ?? 'cohort/final inputs/owned cleanup refused');
}
