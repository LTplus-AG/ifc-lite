/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Labels for the canonical visibility-reason rows (#5869). */
export const visibilityReasonsEn = {
  'visibilityEmpty.title': 'Nothing is visible: the active filters exclude every element.',
  'visibilityEmpty.reasons': 'Active reasons: {reasons}',
  'visibilityEmpty.reset': 'Reset everything',
  'visibilityReasons.hidden': 'Hidden elements',
  'visibilityReasons.isolation': 'Isolated elements',
  'visibilityReasons.ghost': 'X-ray context',
  'visibilityReasons.classFilter': 'Class filter',
  'visibilityReasons.storey': 'Storey filter or Solo view',
  'visibilityReasons.exploded': 'Exploded levels',
  'visibilityReasons.modelHidden': 'Hidden models',
  'visibilityReasons.lens': 'Active lens',
  'visibilityReasons.typeVisibility': 'Hidden IFC classes',
  'visibilityReasons.typeViewMode': 'Types view',
  'visibilityReasons.hostTypes': 'Classes hidden by host',
  'visibilityChips.hiddenCount': 'Hidden elements · {count}',
  'visibilityChips.isolationCount': 'Isolated elements · {count}',
  'visibilityChips.ghostCount': 'X-ray context · {count}',
  'visibilityChips.classFilterCount': 'Class filter · {count}',
  'visibilityChips.storeyCount': 'Storey filter · {count}',
  'visibilityChips.soloCount': 'Solo · {count} storey',
  'visibilityChips.soloCountPlural': 'Solo · {count} storeys',
  'visibilityChips.explodedGap': 'Exploded · {gap} m gap',
  'visibilityChips.modelHiddenCount': 'Model hidden · {hidden} of {total} models',
  'visibilityChips.modelHiddenSingleCount': 'Model hidden · {hidden} of {total} model',
  'visibilityChips.typeVisibilityCount': 'Hidden IFC classes · {count}',
  'visibilityChips.hostTypesCount': 'Classes hidden by host · {count}',
  'visibilityChips.clearAriaLabel': 'Clear {reason}',
  'visibilityChips.keptTooltip': 'Show all keeps this setting. Change it in its control.',
  'visibilityChips.resetEverything': 'Reset everything',
} satisfies Record<string, TranslationValue>;
