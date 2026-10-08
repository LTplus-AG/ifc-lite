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
  'deviationStats.resultSource': 'BIM ↔ scan deviation',
  'deviationStats.readbackPopulation': { one: '{countDisplay} scan point read back', other: '{countDisplay} scan points read back' },
  'deviationStats.validPopulation': '{countDisplay} / {total} readback points measured',
  'deviationStats.sourceUnknown': 'The scan source of this readback was not recorded.',
  'deviationStats.assetSourceUnknown': { one: 'The model for {count} scan asset could not be resolved.', other: 'The models for {count} scan assets could not be resolved.' },
  'deviationStats.assetIdentityUnknown': { one: 'The IFC identity of {count} scan asset could not be resolved.', other: 'The IFC identities of {count} scan assets could not be resolved.' },
  'deviationStats.unmeasuredPoints': { one: '{count} readback point has no finite measured distance.', other: '{count} readback points have no finite measured distance.' },
  'deviationStats.noMeasuredPoints': 'No finite measured distances are available from this readback',
  'deviationStats.sourceAssets': 'Readback scan sources',
  'deviationStats.unknownAsset': 'Unresolved scan asset',
  'deviationStats.assetGlobalId': 'GlobalId',
  'deviationStats.sectionLabel': 'Deviation statistics',
  'deviationStats.reading': 'Computing statistics…',
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
