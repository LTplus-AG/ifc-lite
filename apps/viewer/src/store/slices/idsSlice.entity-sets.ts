/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS slice's cached failed/passed lookup sets, split out of `idsSlice.ts`
 * (which sits at its module-size budget) unchanged.
 */

import type { ValidationReport } from '@ifc-lite/ids';

/**
 * Build cached entity ID sets from validation report
 */
export function buildEntityIdSets(
  report: ValidationReport | null
): { failed: Set<string>; passed: Set<string> } {
  const failed = new Set<string>();
  const passed = new Set<string>();

  if (!report) {
    return { failed, passed };
  }

  for (const specResult of report.specificationResults) {
    for (const entityResult of specResult.entityResults) {
      const key = `${entityResult.modelId}:${entityResult.expressId}`;
      if (entityResult.passed) {
        passed.add(key);
      } else {
        failed.add(key);
      }
    }
  }

  return { failed, passed };
}
