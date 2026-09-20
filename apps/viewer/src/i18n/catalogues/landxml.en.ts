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
  'properties.landXmlSource.heading': 'LandXML Source',
  'properties.landXmlSource.navigation': 'Source Navigation',
  'properties.landXmlSource.kind': 'Kind',
  'properties.landXmlSource.facePoints': 'Face points',
  'properties.landXmlSource.pointCoordinates': 'Coordinates',
  'properties.landXmlSource.points': 'Points',
  'properties.landXmlSource.pickLimitation': 'The renderer identifies the selected terrain surface, but does not report a triangle index, so source faces must be selected from this list.',
} as const satisfies Record<string, TranslationValue>;
