/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runtime narrowing for the generalised validation report (issue #5138).
 *
 * `IDSValidationReport` narrows `ValidationReport.specificationResults`
 * (to `IDSSpecificationResult[]`, carrying `requirement.facet` etc.) in a
 * way TypeScript's control-flow analysis cannot derive from `source.kind`
 * alone — narrowing `source` doesn't touch a sibling field's type. This
 * guard is the one place that cast happens, checked against the same
 * discriminant every `ValidationSource` consumer already reads.
 *
 * A separate file (not `types.ts` or `report-types.ts`) because those two
 * already import from each other for the type-only declarations; keeping
 * the one runtime function that needs both out of that cycle keeps it
 * type-only end to end.
 */

import type { ValidationReport, IDSValidationReport } from './types.js';

export function isIDSValidationReport(report: ValidationReport): report is IDSValidationReport {
  return report.source.kind === 'ids';
}
