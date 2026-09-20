/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const landXmlEn = {
  'properties.modelMetadata.sourceStatisticsHeading': 'Source Statistics',
  'properties.modelMetadata.sourceSurfaces': 'Surfaces',
  'properties.modelMetadata.sourcePoints': 'Source Points',
  'properties.modelMetadata.sourceOverlays': 'Source Overlays',
  'properties.modelMetadata.noSourceOverlays': 'No boundary, breakline or contour records.',
} as const satisfies Record<string, TranslationValue>;
