/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Which failed IDS requirements the correction dialog can address (#3929, #5200). */

import type { IDSEntityResult, IDSSpecificationResult } from '@ifc-lite/ids';
import { checkCorrectionEligibility, type CorrectionTarget } from './idsCorrection';

/**
 * The set of requirements in a spec that are structurally correctable
 * (exact-name scalar property facet) and have at least one failing entity.
 * Keyed by requirement id so the dialog can offer a picker when a spec
 * carries more than one correctable requirement.
 */
export interface CorrectableRequirement {
  requirementId: string;
  description: string;
  target: CorrectionTarget;
  failedEntities: IDSEntityResult[];
  /** The facet's declared dataType constraint (e.g. "IFCLABEL"), if it names an exact value. */
  facetDataType?: string;
}

/**
 * `specResult` is a captured, one-time audit snapshot (`IDSPanel` re-runs
 * validation only on explicit user action), so an entity deleted after the
 * audit ran is otherwise indistinguishable here from a live failing one
 * (#5200). `isDeleted`, when given, drops such entities before they ever
 * reach `failedEntities` — the dialog's list, its selection count, and
 * `handleApply`'s write set all derive from this one function's output, so
 * filtering here keeps all three honest by construction rather than
 * requiring a second check at apply time.
 */
export function getCorrectableRequirements(
  specResult: IDSSpecificationResult,
  isDeleted?: (expressId: number) => boolean,
): CorrectableRequirement[] {
  const byId = new Map<string, CorrectableRequirement>();
  const rejected = new Set<string>();

  for (const entity of specResult.entityResults) {
    if (isDeleted?.(entity.expressId)) continue;
    for (const reqResult of entity.requirementResults) {
      if (reqResult.status !== 'fail') continue;
      const id = reqResult.requirement.id;
      if (rejected.has(id)) continue;

      const existing = byId.get(id);
      if (existing) {
        existing.failedEntities.push(entity);
        continue;
      }

      const eligibility = checkCorrectionEligibility(reqResult);
      if (!eligibility.eligible) {
        rejected.add(id);
        continue;
      }
      const facet = reqResult.requirement.facet;
      const facetDataType =
        facet.type === 'property' && facet.dataType?.type === 'simpleValue'
          ? facet.dataType.value
          : undefined;
      byId.set(id, {
        requirementId: id,
        description: reqResult.checkedDescription,
        target: { psetName: eligibility.psetName, propName: eligibility.propName },
        failedEntities: [entity],
        facetDataType,
      });
    }
  }

  return Array.from(byId.values());
}
