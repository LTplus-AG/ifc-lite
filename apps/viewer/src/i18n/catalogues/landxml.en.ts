/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const landXmlEn = {
  'properties.modelMetadata.sourceStatisticsHeading': 'Source Statistics',
  'properties.modelMetadata.sourceSurfaces': 'Surfaces',
  'properties.modelMetadata.sourcePoints': 'Source Points',
  'properties.modelMetadata.sourceOverlays': 'Source Overlays',
  'properties.modelMetadata.sourceSurfaceRecords': 'Source Surfaces',
  'properties.modelMetadata.sourcePipeRecords': 'Pipe Records',
  'properties.modelMetadata.sourcePipeNetworks': 'Pipe Networks',
  'properties.modelMetadata.noSourceOverlays': 'No boundary, breakline or contour records.',
  'properties.landXmlSource.heading': 'LandXML Source',
  'properties.landXmlSource.navigation': 'Source Navigation',
  'properties.landXmlSource.reviewRecords': 'Profile and roadway records',
  'properties.landXmlSource.noReviewRecords': 'No retained alignment, profile, cross-section, roadway, or source-only records.',
  'properties.landXmlSource.diagnostics': 'Capability diagnostics',
  'properties.landXmlSource.noDiagnostics': 'No retained capability diagnostics.',
  'properties.landXmlSource.kind': 'Kind',
  'properties.landXmlSource.facePoints': 'Face points',
  'properties.landXmlSource.pointCoordinates': 'Coordinates',
  'properties.landXmlSource.points': 'Points',
  'properties.landXmlSource.pickLimitation': 'The renderer identifies the selected terrain surface, but does not report a triangle index, so source faces must be selected from this list.',
  'properties.landXmlSource.previous': 'Previous',
  'properties.landXmlSource.next': 'Next',
  'properties.landXmlSource.page': 'Page {current} of {total}',
  'properties.landXmlSource.renderState': 'Render state',
  'properties.landXmlSource.capabilities': 'Capabilities',
  'properties.landXmlSource.counts': 'Source/render counts',
  'properties.landXmlSource.countsValue': '{sourcePoints} source points, {sourceFaces} source faces, {renderedFaces} rendered, {droppedDegenerateFaces} degenerate, {droppedPrecisionFaces} precision, {droppedReframeFaces} frame-rejected',
  'properties.landXmlSource.surfaceProperties': 'Surface Properties',
  'properties.landXmlSource.definitionProperties': 'Definition Properties',
  'properties.landXmlSource.noProperties': 'No retained properties.',
} as const satisfies Record<string, TranslationValue>;
