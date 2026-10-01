/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateChartSpec } from './validate.js';
import type { ChartSource, ChartSpec } from './types.js';

const chart: ChartSpec = { id: 'recorded', title: 'Recorded comparison', source: 'compare', type: 'bar', dimension: 'State', measure: { agg: 'count' } };

describe('Saved comparison binding contract (#6549)', () => {
  it('accepts an optional completed-comparison ID and keeps legacy charts valid', () => {
    expect(validateChartSpec(chart)).toEqual([]);
    expect(validateChartSpec({ ...chart, comparisonId: 'completed-comparison' })).toEqual([]);
  });
  it('rejects empty, whitespace, non-string, and non-comparison bindings at import', () => {
    for (const comparisonId of ['', '  \t', 12, null, {}]) expect(validateChartSpec({ ...chart, comparisonId }).some(({ path }) => path.endsWith('.comparisonId'))).toBe(true);
    for (const source of ['elements', 'clash', 'bcf', 'schedule', 'ids'] as ChartSource[]) {
      expect(validateChartSpec({ ...chart, source, comparisonId: 'completed-comparison' }).some(({ path }) => path.endsWith('.comparisonId'))).toBe(true);
    }
  });
  it('rejects live element selectors and rule groups on recorded comparison sources (#6549)', () => {
    for (const filter of [{ selector: 'IfcWall' }, { selector: '', groups: [{ combinator: 'AND', rules: [{ field: 'type', operator: 'equals', value: 'IfcWall' }] }] }]) {
      expect(validateChartSpec({ ...chart, comparisonId: 'completed-comparison', filter }).some(({ path, message }) => path.endsWith('.filter') && message.includes('not applicable'))).toBe(true);
    }
  });

});
