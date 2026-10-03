/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { protocol, schedule } from './sdk-plan.mjs';
export function requireBuildCompletion(receipt, refusal) {
  if (refusal || receipt.exit !== 0 || receipt.cleanup.status !== 'complete'
    || receipt.logFlush.status !== 'complete' || receipt.pipeTailCertified === false
    || receipt.abortCleanup?.status === 'refused') throw new Error(refusal ?? 'build/cleanup/log refused');
}
export function requireCohortCompletion(report, refusal) {
  const declared = protocol(report.selector), planned = schedule(declared.selector);
  const sampleFields = ['id', 'family', 'pair', 'slot', 'kind', 'arm'];
  if (refusal || report.ownedCleanup.status !== 'complete'
    || report.serverCleanup.some(item => item.status !== 'complete' || item.serverFault)
    || report.samples.length !== declared.expectedSamples || report.samples.some(item => item.status !== 'complete')
    || report.pairs.length !== declared.expectedPairs || report.pairs.some(item => item.status !== 'complete')
    || report.samples.some((row, index) => sampleFields.some(field => row[field] !== planned[index][field]))
    || report.pairs.some((row, index) => row.family !== planned[index * 2].family
      || row.index !== planned[index * 2].pair || row.kind !== planned[index * 2].kind)
    || report.finalInputVerification !== 'complete') throw new Error(refusal ?? 'cohort/final inputs/owned cleanup refused');
}
