/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Charts panel's chart editor Source filter field (#4946). Covers only
 * the copy the source filter added — the rest of `ChartEditor.tsx` (chart
 * type, dimension, measure, …) is not converted yet, same incremental-slice
 * approach the other catalogues use.
 */
export const chartsEn = {
  'chartEditor.sourceFilterLabel': 'Source filter (selector)',
  'chartEditor.sourceFilterAriaLabel': 'Source filter',
  'chartEditor.selectorSyntaxReference': 'Selector syntax reference',
  'chartEditor.sourceFilterNotApplicable': 'Source filter is not applicable to {source}.',
} as const satisfies Record<string, TranslationValue>;
