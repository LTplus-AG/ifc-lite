/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const visibilityReasonsFr = {
  'visibilityEmpty.title': 'Rien n’est visible : les filtres actifs excluent tous les éléments.',
  'visibilityEmpty.reasons': 'Raisons actives : {reasons}',
  'visibilityEmpty.reset': 'Tout réinitialiser',
  'visibilityReasons.hidden': 'Éléments masqués',
  'visibilityReasons.isolation': 'Éléments isolés',
  'visibilityReasons.ghost': 'Contexte rayons X',
  'visibilityReasons.classFilter': 'Filtre de classes',
  'visibilityReasons.storey': 'Filtre d’étages ou vue solo',
  'visibilityReasons.exploded': 'Étages éclatés',
  'visibilityReasons.modelHidden': 'Modèles masqués',
  'visibilityReasons.lens': 'Lentille active',
  'visibilityReasons.typeVisibility': 'Classes IFC masquées',
  'visibilityReasons.typeViewMode': 'Vue des types',
  'visibilityReasons.hostTypes': 'Classes masquées par l’hôte',
  'visibilityReasons.section': 'Coupe',
  'visibilityReasons.measurements': 'Mesures',
  'visibilityChips.hiddenCount': 'Éléments masqués · {count}',
  'visibilityChips.isolationCount': 'Éléments isolés · {count}',
  'visibilityChips.ghostCount': 'Contexte rayons X · {count}',
  'visibilityChips.classFilterCount': 'Filtre de classes · {count}',
  'visibilityChips.storeyCount': 'Filtre d’étages · {count}',
  'visibilityChips.soloCount': 'Solo · {count} étage',
  'visibilityChips.soloCountPlural': 'Solo · {count} étages',
  'visibilityChips.explodedGap': 'Éclaté · écart de {gap} m',
  'visibilityChips.modelHiddenCount': 'Modèles masqués · {hidden} sur {total} modèles',
  'visibilityChips.modelHiddenSingleCount': 'Modèle masqué · {hidden} sur {total} modèle',
  'visibilityChips.typeVisibilityCount': 'Classes IFC masquées · {count}',
  'visibilityChips.hostTypesCount': 'Classes masquées par l’hôte · {count}',
  'visibilityChips.clearAriaLabel': 'Effacer : {reason}',
  'visibilityChips.keptTooltip': 'Tout afficher conserve ce réglage. Modifiez-le dans sa commande.',
  'visibilityChips.resetEverything': 'Tout réinitialiser',
} satisfies Catalogue;
