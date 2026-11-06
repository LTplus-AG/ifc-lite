/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const deviationStatsDe = {
  'deviationStats.resultSource': 'Abweichung BIM ↔ Scan',
  'deviationStats.readbackPopulation': { one: '{countDisplay} Scanpunkt zurückgelesen', other: '{countDisplay} Scanpunkte zurückgelesen' },
  'deviationStats.validPopulation': '{countDisplay} / {total} zurückgelesene Punkte gemessen',
  'deviationStats.sourceUnknown': 'Die Scanquelle dieser Rücklesung wurde nicht aufgezeichnet.',
  'deviationStats.assetSourceUnknown': { one: 'Das Modell für {count} Scan-Asset konnte nicht aufgelöst werden.', other: 'Die Modelle für {count} Scan-Assets konnten nicht aufgelöst werden.' },
  'deviationStats.assetIdentityUnknown': { one: 'Die IFC-Identität von {count} Scan-Asset konnte nicht aufgelöst werden.', other: 'Die IFC-Identitäten von {count} Scan-Assets konnten nicht aufgelöst werden.' },
  'deviationStats.unmeasuredPoints': { one: '{count} zurückgelesener Punkt hat keinen endlichen gemessenen Abstand.', other: '{count} zurückgelesene Punkte haben keinen endlichen gemessenen Abstand.' },
  'deviationStats.noMeasuredPoints': 'Aus dieser Rücklesung sind keine endlichen gemessenen Abstände verfügbar',
  'deviationStats.sourceAssets': 'Scanquellen der Rücklesung',
  'deviationStats.unknownAsset': 'Nicht aufgelöstes Scan-Asset',
  'deviationStats.assetGlobalId': 'GlobalId',
  'deviationStats.sectionLabel': 'Abweichungsstatistik',
  'deviationStats.reading': 'Statistik wird berechnet …',
  'deviationStats.valueMm': '{value} mm',
  'deviationStats.unitMm': 'mm',
  'deviationStats.notAvailable': '—',
  'deviationStats.mean': 'Mittelwert',
  'deviationStats.meanAbs': 'Mittelwert |d|',
  'deviationStats.rms': 'RMS',
  'deviationStats.stdDev': 'Standardabweichung',
  'deviationStats.p50Abs': 'P50 |d|',
  'deviationStats.p95Abs': 'P95 |d|',
  'deviationStats.p99Abs': 'P99 |d|',
  'deviationStats.maxAbs': 'Max. |d|',
  'deviationStats.pointsMeasured': 'Gemessene Punkte',
  'deviationStats.toleranceLabel': 'Toleranz ±',
  'deviationStats.toleranceAriaLabel': 'Abweichungstoleranz in Millimetern',
  'deviationStats.withinTolerance': '{share} innerhalb von ±{tolerance} mm ({count} von {total})',
  'deviationStats.histogramAriaLabel':
    'Histogramm der vorzeichenbehafteten Abweichung von {min} bis {max} mm in {bins} Klassen; {below} Punkte unterhalb und {above} oberhalb des Bereichs',
  'deviationStats.outsideRange': '{below} unterhalb · {above} oberhalb des Farbbereichs',
  'deviationStats.clippedPoints': {
    one: '{countDisplay} Punkt hat die Berechnungsgrenze von ±{clip} m erreicht; sein tatsächlicher Abstand ist größer',
    other: '{countDisplay} Punkte haben die Berechnungsgrenze von ±{clip} m erreicht; ihr tatsächlicher Abstand ist größer',
  },
  'deviationStats.csvAllAssetsName': 'Alle Scan-Assets',
} satisfies Catalogue;
