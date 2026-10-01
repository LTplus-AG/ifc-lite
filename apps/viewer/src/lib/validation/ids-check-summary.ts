/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { boundedPassRate, isIDSValidationReport, type ValidationReport } from '@ifc-lite/ids';
import { computeCheckStats } from '@/hooks/ids/idsRequirementGrouping';

/** #6551: IFC Tester counts entity × requirement checks; the engine summary
 * counts entity × specification results. Keep both units explicit. */
export function idsCheckSummary(report: ValidationReport) {
  if (!isIDSValidationReport(report)) return null;
  let passed = 0;
  let failed = 0;
  let requirements = 0;
  let passedRequirements = 0;
  for (const result of report.specificationResults) {
    // IDS identifiers need not be unique. Each result already carries its
    // full specification; never join it back to the document by identifier.
    const spec = result.specification;
    // Failed entities must be present to count their individual checks.
    // Passing entities may be omitted by includePassingEntities=false.
    const retainedFailed = result.entityResults.filter((entity) => !entity.passed).length;
    if (result.error || retainedFailed !== result.failedCount) return null;
    const retainedPassed = result.entityResults.length - retainedFailed;
    const omittedPassed = result.passedCount - retainedPassed;
    if (omittedPassed < 0 || result.passedCount + result.failedCount !== result.applicableCount) return null;
    const stats = computeCheckStats(result.entityResults);
    // The IDS validator emits pass/fail for every requirement; an omitted
    // passing entity therefore passed every requirement in its specification.
    passed += stats.passedChecks + omittedPassed * spec.requirements.length;
    failed += stats.failedChecks;
    const failedRequirements = new Set<string>();
    for (const entity of result.entityResults) {
      for (const check of entity.requirementResults) {
        if (check.status === 'fail') failedRequirements.add(check.requirement.id);
      }
    }
    requirements += spec.requirements.length;
    // IFC Tester fails the requirements of a required specification with no
    // matching entities, even though it contributes no individual checks.
    if (!(result.applicableCount === 0 && result.cardinalityResult?.passed === false)) {
      passedRequirements += spec.requirements.filter((requirement) => !failedRequirements.has(requirement.id)).length;
    }
  }
  return { passed, failed, checked: passed + failed, passRate: boundedPassRate(passed, passed + failed),
    requirements, passedRequirements };
}
