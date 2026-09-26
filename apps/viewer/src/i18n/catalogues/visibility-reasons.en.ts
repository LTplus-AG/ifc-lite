/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Labels for the canonical visibility-reason rows (#5869). */
export const visibilityReasonsEn = {
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
  'visibilityReasons.section': 'Section cut',
  'visibilityReasons.measurements': 'Measurements',
} satisfies Record<string, TranslationValue>;
