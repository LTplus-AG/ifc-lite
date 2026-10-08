/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateChartSpec } from './validate.js';
import type { ChartSource, ChartSourceFilter, ChartSpec } from './types.js';

const chart: ChartSpec = { id: 'saved-run', title: 'Saved clash run', source: 'clash', type: 'bar', dimension: 'Severity', measure: { agg: 'count' } };

describe('Saved clash report binding contract (#6947)', () => {
  it('keeps unbound clash charts valid and accepts a saved report ID', () => {
    expect(validateChartSpec(chart)).toEqual([]);
    expect(validateChartSpec({ ...chart, clashReportId: 'clash-report-a' })).toEqual([]);
  });
  it('rejects empty, whitespace and non-string IDs', () => {
    for (const clashReportId of ['', '  \t', 12, null, {}]) {
      expect(validateChartSpec({ ...chart, clashReportId }).some(({ path }) => path.endsWith('.clashReportId'))).toBe(true);
    }
  });
  it('rejects a saved clash report on every other source', () => {
    for (const source of ['elements', 'bcf', 'schedule', 'ids', 'compare'] as ChartSource[]) {
      expect(validateChartSpec({ ...chart, source, clashReportId: 'clash-report-a' }).some(({ path }) => path.endsWith('.clashReportId'))).toBe(true);
    }
  });
  it('rejects element filters on a saved report but keeps the rule filter', () => {
    const elementFilters: ChartSourceFilter[] = [{ selector: 'IfcWall' }, { selector: '', groups: [{ combinator: 'AND', rules: [{ kind: 'modelTag', op: 'hasAny', tagIds: ['structure'] }] }] }];
    for (const filter of elementFilters) {
      // Control: the same filter is valid on the current clash result.
      expect(validateChartSpec({ ...chart, filter })).toEqual([]);
      expect(validateChartSpec({ ...chart, clashReportId: 'clash-report-a', filter }).some(({ path, message }) => path.endsWith('.filter') && message.includes('saved clash report'))).toBe(true);
    }
    expect(validateChartSpec({ ...chart, clashReportId: 'clash-report-a', filter: { selector: '', clashRule: 'rule-1' } })).toEqual([]);
  });
});
