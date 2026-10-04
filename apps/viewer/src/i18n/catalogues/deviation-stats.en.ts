/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `deviationStats.*` — `DeviationStatistics.tsx`, the summary block under the
 * BIM ↔ scan deviation legend (#6872): signed and absolute moments, |d|
 * percentiles, the tolerance input and share, and the ramp-aligned histogram.
 * Distances arrive pre-formatted in millimetres; `{value}` carries the
 * locale's digits and separators.
 */

import type { TranslationValue } from '../types';

export const deviationStatsEn = {
  'deviationStats.sectionLabel': 'Deviation statistics',
  'deviationStats.reading': 'Reading distances…',
  'deviationStats.valueMm': '{value} mm',
  'deviationStats.unitMm': 'mm',
  'deviationStats.notAvailable': '—',
  'deviationStats.mean': 'Mean',
  'deviationStats.meanAbs': 'Mean |d|',
  'deviationStats.rms': 'RMS',
  'deviationStats.stdDev': 'Std. deviation',
  'deviationStats.p50Abs': 'P50 |d|',
  'deviationStats.p95Abs': 'P95 |d|',
  'deviationStats.p99Abs': 'P99 |d|',
  'deviationStats.maxAbs': 'Max |d|',
  'deviationStats.pointsMeasured': 'Points measured',
  'deviationStats.toleranceLabel': 'Tolerance ±',
  'deviationStats.toleranceAriaLabel': 'Deviation tolerance in millimetres',
  'deviationStats.withinTolerance': '{share} within ±{tolerance} mm ({count} of {total})',
  'deviationStats.histogramAriaLabel':
    'Histogram of signed deviation from {min} to {max} mm in {bins} bins; {below} points below and {above} above the range',
  'deviationStats.outsideRange': '{below} below · {above} above the colour range',
  'deviationStats.clippedPoints': {
    one: '{countDisplay} point reached the ±{clip} m compute limit; its true distance is larger',
    other: '{countDisplay} points reached the ±{clip} m compute limit; their true distance is larger',
  },
  'deviationStats.csvAllAssetsName': 'All scan assets',
} as const satisfies Record<string, TranslationValue>;
