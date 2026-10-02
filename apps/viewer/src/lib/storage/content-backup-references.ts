/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DocumentSpec } from '../document/types.js';

/** Preserve library bindings when conflicting backup entries get fresh IDs (#6679).
 * Embedded evidence stays intact; only its source-library reference changes. */
export function rebindContentDocument(document: DocumentSpec,
  comparisons: ReadonlyMap<string, string>, validation: ReadonlyMap<string, string>): DocumentSpec {
  return { ...document, blocks: document.blocks.map(block => {
    if (block.kind === 'chart' && block.chart.comparisonId) {
      const id = comparisons.get(block.chart.comparisonId);
      if (id) return { ...block, chart: { ...block.chart, comparisonId: id } };
    }
    if ((block.kind === 'ids-report' || block.kind === 'manual-report') && block.savedReportId) {
      const id = validation.get(block.savedReportId);
      if (id) return { ...block, savedReportId: id };
    }
    return block;
  }) };
}
