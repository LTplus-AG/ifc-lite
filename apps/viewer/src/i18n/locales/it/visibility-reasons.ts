/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const visibilityReasonsIt = {
  'visibilityEmpty.title': 'Non è visibile nulla: i filtri attivi escludono tutti gli elementi.',
  'visibilityEmpty.reasons': 'Motivi attivi: {reasons}',
  'visibilityEmpty.reset': 'Ripristina tutto',
  'visibilityReasons.hidden': 'Elementi nascosti',
  'visibilityReasons.isolation': 'Elementi isolati',
  'visibilityReasons.ghost': 'Contesto a raggi X',
  'visibilityReasons.classFilter': 'Filtro per classe',
  'visibilityReasons.storey': 'Filtro per piano o vista Solo',
  'visibilityReasons.exploded': 'Livelli esplosi',
  'visibilityReasons.modelHidden': 'Modelli nascosti',
  'visibilityReasons.lens': 'Lente attiva',
  'visibilityReasons.typeVisibility': 'Classi IFC nascoste',
  'visibilityReasons.typeViewMode': 'Vista per tipi',
  'visibilityReasons.hostTypes': 'Classi nascoste dalla pagina ospitante',
  'visibilityReasons.section': 'Taglio di sezione',
  'visibilityReasons.measurements': 'Misure',
  'visibilityChips.hiddenCount': 'Elementi nascosti · {count}',
  'visibilityChips.isolationCount': 'Elementi isolati · {count}',
  'visibilityChips.ghostCount': 'Contesto a raggi X · {count}',
  'visibilityChips.classFilterCount': 'Filtro per classe · {count}',
  'visibilityChips.storeyCount': 'Filtro per piano · {count}',
  'visibilityChips.soloCount': 'Solo · {count} piano',
  'visibilityChips.soloCountPlural': 'Solo · {count} piani',
  'visibilityChips.explodedGap': 'Esploso · distanza {gap} m',
  'visibilityChips.modelHiddenCount': 'Modello nascosto · {hidden} di {total} modelli',
  'visibilityChips.modelHiddenSingleCount': 'Modello nascosto · {hidden} di {total} modello',
  'visibilityChips.typeVisibilityCount': 'Classi IFC nascoste · {count}',
  'visibilityChips.hostTypesCount': 'Classi nascoste dalla pagina ospitante · {count}',
  'visibilityChips.clearAriaLabel': 'Rimuovi {reason}',
  'visibilityChips.keptTooltip': 'Mostra tutto conserva questa impostazione. Modificala nel suo controllo.',
  'visibilityChips.resetEverything': 'Ripristina tutto',
} satisfies Catalogue;
