/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Map a validator result onto the runner's outcome. */

import type { IDSSpecificationResult } from '@ifc-lite/ids';
import type { SpecOutcome } from './runner.js';

/**
 * The outcome of one specification result of `validateIDS`. Requirement
 * ids are the Studio node ids when the validated document came from a
 * `StudioDocument` (its requirement `id`s are node ids).
 */
export function outcomeFromSpecResult(result: IDSSpecificationResult): SpecOutcome {
  const failed = new Set<string>();
  for (const entity of result.entityResults) {
    for (const r of entity.requirementResults) if (r.status === 'fail') failed.add(r.requirement.id);
  }
  return {
    status: result.status === 'not_applicable' ? 'notApplicable' : result.status,
    failedRequirements: [...failed],
    applicableCount: result.applicableCount,
  };
}
