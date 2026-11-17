/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const deviationStatsIt = {
  'deviationStats.resultSource': 'Scostamento BIM ↔ scansione',
  'deviationStats.readbackPopulation': {
    one: '{countDisplay} punto di scansione riletto',
    many: '{countDisplay} punti di scansione riletti',
    other: '{countDisplay} punti di scansione riletti',
  },
  'deviationStats.validPopulation': '{countDisplay} / {total} punti riletti misurati',
  'deviationStats.sourceUnknown': 'L’origine di scansione di questa rilettura non è stata registrata.',
  'deviationStats.assetSourceUnknown': {
    one: 'Non è stato possibile risolvere il modello di {count} risorsa di scansione.',
    many: 'Non è stato possibile risolvere i modelli di {count} risorse di scansione.',
    other: 'Non è stato possibile risolvere i modelli di {count} risorse di scansione.',
  },
  'deviationStats.assetIdentityUnknown': {
    one: 'Non è stato possibile risolvere l’identità IFC di {count} risorsa di scansione.',
    many: 'Non è stato possibile risolvere le identità IFC di {count} risorse di scansione.',
    other: 'Non è stato possibile risolvere le identità IFC di {count} risorse di scansione.',
  },
  'deviationStats.unmeasuredPoints': {
    one: '{count} punto riletto non ha una distanza misurata finita.',
    many: '{count} punti riletti non hanno una distanza misurata finita.',
    other: '{count} punti riletti non hanno una distanza misurata finita.',
  },
  'deviationStats.noMeasuredPoints': 'Da questa rilettura non è disponibile alcuna distanza misurata finita',
  'deviationStats.sourceAssets': 'Origini di scansione della rilettura',
  'deviationStats.unknownAsset': 'Risorsa di scansione non risolta',
  'deviationStats.assetGlobalId': 'GlobalId',
  'deviationStats.sectionLabel': 'Statistiche di scostamento',
  'deviationStats.reading': 'Calcolo delle statistiche…',
  'deviationStats.valueMm': '{value} mm',
  'deviationStats.unitMm': 'mm',
  'deviationStats.notAvailable': '—',
  'deviationStats.mean': 'Media',
  'deviationStats.meanAbs': 'Media |d|',
  'deviationStats.rms': 'RMS',
  'deviationStats.stdDev': 'Deviazione standard',
  'deviationStats.p50Abs': 'P50 |d|',
  'deviationStats.p95Abs': 'P95 |d|',
  'deviationStats.p99Abs': 'P99 |d|',
  'deviationStats.maxAbs': 'Max |d|',
  'deviationStats.pointsMeasured': 'Punti misurati',
  'deviationStats.toleranceLabel': 'Tolleranza ±',
  'deviationStats.toleranceAriaLabel': 'Tolleranza di scostamento in millimetri',
  'deviationStats.withinTolerance': '{share} entro ±{tolerance} mm ({count} di {total})',
  'deviationStats.histogramAriaLabel':
    'Istogramma dello scostamento con segno da {min} a {max} mm in {bins} classi; {below} punti sotto e {above} sopra l’intervallo',
  'deviationStats.outsideRange': '{below} sotto · {above} sopra l’intervallo di colori',
  'deviationStats.clippedPoints': {
    one: '{countDisplay} punto ha raggiunto il limite di calcolo di ±{clip} m; la sua distanza reale è maggiore',
    many: '{countDisplay} punti hanno raggiunto il limite di calcolo di ±{clip} m; la loro distanza reale è maggiore',
    other: '{countDisplay} punti hanno raggiunto il limite di calcolo di ±{clip} m; la loro distanza reale è maggiore',
  },
  'deviationStats.csvAllAssetsName': 'Tutte le risorse di scansione',
} satisfies Catalogue;
