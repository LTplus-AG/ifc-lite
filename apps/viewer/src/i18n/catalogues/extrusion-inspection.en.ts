/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const extrusionInspectionEn = {
  'properties.extrusion.heading': 'Authored extrusion sources',
  'properties.extrusion.sourceNote': 'Exact IFC profile and extrusion parameters. Lengths are displayed in metres or your selected unit; profiles are source geometry before placement, openings, and other cuts.',
  'properties.extrusion.loading': 'Reading selected extrusion sources…',
  'properties.extrusion.empty': 'No extruded-area-solid source geometry for this selection',
  'properties.extrusion.solid': 'IfcExtrudedAreaSolid #{id}',
  'properties.extrusion.status': 'Description',
  'properties.extrusion.complete': 'Complete',
  'properties.extrusion.unsupported': 'Unsupported',
  'properties.extrusion.missingSource': 'Source definition is unavailable for this occurrence.',
  'properties.extrusion.sourceModified': 'Source modified by CSG',
  'properties.extrusion.modifiedHint': 'The authored profile may differ from the visible result.',
  'properties.extrusion.yes': 'Yes',
  'properties.extrusion.no': 'No',
  'properties.extrusion.none': 'None',
  'properties.extrusion.mappingPath': 'Mapped path',
  'properties.extrusion.depth': 'Depth',
  'properties.extrusion.direction': 'ExtrudedDirection ratios',
  'properties.extrusion.position': 'Solid Position',
  'properties.extrusion.profile': 'SweptArea',
  'properties.extrusion.profileType': 'ProfileType',
  'properties.extrusion.profilePosition': 'Profile Position',
  'properties.extrusion.loop': 'Loop {index}',
  'properties.extrusion.segments': 'segments',
  'properties.extrusion.perimeter': 'Perimeter',
  'properties.extrusion.signedArea': 'Signed area',
} satisfies Record<string, TranslationValue>;
