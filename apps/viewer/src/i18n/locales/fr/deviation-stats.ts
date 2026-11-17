/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const deviationStatsFr = {
  'deviationStats.resultSource': 'Écart BIM ↔ scan',
  'deviationStats.readbackPopulation': { one: '{countDisplay} point de scan relu', many: '{countDisplay} de points de scan relus', other: '{countDisplay} points de scan relus' },
  'deviationStats.validPopulation': '{countDisplay} / {total} points relus mesurés',
  'deviationStats.sourceUnknown': 'La source de scan de cette relecture n’a pas été enregistrée.',
  'deviationStats.assetSourceUnknown': { one: 'Le modèle de {count} ressource de scan n’a pas pu être résolu.', many: 'Les modèles de {count} de ressources de scan n’ont pas pu être résolus.', other: 'Les modèles de {count} ressources de scan n’ont pas pu être résolus.' },
  'deviationStats.assetIdentityUnknown': { one: 'L’identité IFC de {count} ressource de scan n’a pas pu être résolue.', many: 'Les identités IFC de {count} de ressources de scan n’ont pas pu être résolues.', other: 'Les identités IFC de {count} ressources de scan n’ont pas pu être résolues.' },
  'deviationStats.unmeasuredPoints': { one: '{count} point relu n’a pas de distance mesurée finie.', many: '{count} de points relus n’ont pas de distance mesurée finie.', other: '{count} points relus n’ont pas de distance mesurée finie.' },
  'deviationStats.noMeasuredPoints': 'Aucune distance mesurée finie n’est disponible pour cette relecture',
  'deviationStats.sourceAssets': 'Sources de scan relues',
  'deviationStats.unknownAsset': 'Ressource de scan non résolue',
  'deviationStats.assetGlobalId': 'GlobalId',
  'deviationStats.sectionLabel': 'Statistiques d’écart',
  'deviationStats.reading': 'Calcul des statistiques…',
  'deviationStats.valueMm': '{value} mm',
  'deviationStats.unitMm': 'mm',
  'deviationStats.notAvailable': '—',
  'deviationStats.mean': 'Moyenne',
  'deviationStats.meanAbs': 'Moyenne |d|',
  'deviationStats.rms': 'RMS',
  'deviationStats.stdDev': 'Écart type',
  'deviationStats.p50Abs': 'P50 |d|',
  'deviationStats.p95Abs': 'P95 |d|',
  'deviationStats.p99Abs': 'P99 |d|',
  'deviationStats.maxAbs': 'Max |d|',
  'deviationStats.pointsMeasured': 'Points mesurés',
  'deviationStats.toleranceLabel': 'Tolérance ±',
  'deviationStats.toleranceAriaLabel': 'Tolérance d’écart en millimètres',
  'deviationStats.withinTolerance': '{share} dans ±{tolerance} mm ({count} sur {total})',
  'deviationStats.histogramAriaLabel':
    'Histogramme de l’écart signé de {min} à {max} mm en {bins} classes ; {below} points en dessous et {above} au-dessus de la plage',
  'deviationStats.outsideRange': '{below} en dessous · {above} au-dessus de la plage de couleurs',
  'deviationStats.clippedPoints': {
    one: '{countDisplay} point a atteint la limite de calcul de ±{clip} m ; sa distance réelle est plus grande',
    many: '{countDisplay} de points ont atteint la limite de calcul de ±{clip} m ; leur distance réelle est plus grande',
    other: '{countDisplay} points ont atteint la limite de calcul de ±{clip} m ; leur distance réelle est plus grande',
  },
  'deviationStats.csvAllAssetsName': 'Toutes les ressources de scan',
} satisfies Catalogue;
