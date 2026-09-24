/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Viewer inspection/readout of authored swept-disk source geometry (#5783). */
export const sweptDiskInspectionEn = {
  'properties.sweptDisk.heading': 'Derived source geometry',
  'properties.sweptDisk.sourceNote': 'Derived directrix measurements from the authored source. IFC attributes and IfcElementQuantity values are listed separately.',
  'properties.sweptDisk.loading': 'Reading selected source geometry…',
  'properties.sweptDisk.empty': 'No swept-disk source geometry for this selection',
  'properties.sweptDisk.solid': 'IfcSweptDiskSolid #{id}',
  'properties.sweptDisk.status': 'Description',
  'properties.sweptDisk.complete': 'Complete',
  'properties.sweptDisk.unsupported': 'Unsupported',
  'properties.sweptDisk.sourceModified': 'Source modified by CSG',
  'properties.sweptDisk.modifiedHint': 'Source directrix may differ from the visible result.',
  'properties.sweptDisk.modifiedHighlightHint': 'The source segment cannot be highlighted against the CSG-modified mesh.',
  'properties.sweptDisk.yes': 'Yes',
  'properties.sweptDisk.no': 'No',
  'properties.sweptDisk.directrix': 'Source directrix',
  'properties.sweptDisk.mappingPath': 'Mapped path',
  'properties.sweptDisk.none': 'None',
  'properties.sweptDisk.radius': 'Radius',
  'properties.sweptDisk.innerRadius': 'InnerRadius',
  'properties.sweptDisk.unsupportedRadiusHint': 'Radius is the authored value; a world radius could not be established.',
  'properties.sweptDisk.derivedCentreline': 'Derived centreline measurements',
  'properties.sweptDisk.totalLength': 'Total centreline length',
  'properties.sweptDisk.segment': 'Segment {index}',
  'properties.sweptDisk.bend': 'Bend magnitude',
  'properties.sweptDisk.signedSweep': 'Signed sweep',
} satisfies Record<string, TranslationValue>;
