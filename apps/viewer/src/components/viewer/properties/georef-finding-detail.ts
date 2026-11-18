/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeorefFinding, GeorefFindingCode } from '@ifc-lite/sdk/georef-doctor';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n';

/** Existing doctor evidence is structured; never parse its English message (#10658). */
const DETAIL_KEYS = {
  NO_GEOREFERENCE: 'properties.georef.check.detail.NO_GEOREFERENCE',
  SITE_LOCATION_ONLY: 'properties.georef.check.detail.SITE_LOCATION_ONLY',
  SITE_LOCATION_DEFAULT: 'properties.georef.check.detail.SITE_LOCATION_DEFAULT',
  SITE_LOCATION_CONTRADICTS_OPERATION: 'properties.georef.check.detail.SITE_LOCATION_CONTRADICTS_OPERATION',
  MAP_POSITION_APPLIED_TWICE: 'properties.georef.check.detail.MAP_POSITION_APPLIED_TWICE',
  MAP_COORDINATES_IN_PLACEMENTS: 'properties.georef.check.detail.MAP_COORDINATES_IN_PLACEMENTS',
  SCALE_UNIT_MISMATCH: 'properties.georef.check.detail.SCALE_UNIT_MISMATCH',
  SCALE_DOES_NOT_BRIDGE_UNITS: 'properties.georef.check.detail.SCALE_DOES_NOT_BRIDGE_UNITS',
  SCALE_INVALID: 'properties.georef.check.detail.SCALE_INVALID',
  EASTING_ZONE_PREFIX: 'properties.georef.check.detail.EASTING_ZONE_PREFIX',
  EASTING_ZONE_PREFIX_MISSING: 'properties.georef.check.detail.EASTING_ZONE_PREFIX_MISSING',
  LV03_LV95_MIX: 'properties.georef.check.detail.LV03_LV95_MIX',
  OUTSIDE_CRS_AREA: 'properties.georef.check.detail.OUTSIDE_CRS_AREA',
  CRS_NOT_RESOLVABLE: 'properties.georef.check.detail.CRS_NOT_RESOLVABLE',
  OPERATION_WITHOUT_CRS: 'properties.georef.check.detail.OPERATION_WITHOUT_CRS',
  CRS_WITHOUT_OPERATION: 'properties.georef.check.detail.CRS_WITHOUT_OPERATION',
  MAP_UNIT_MISSING: 'properties.georef.check.detail.MAP_UNIT_MISSING',
  VERTICAL_DATUM_MISSING: 'properties.georef.check.detail.VERTICAL_DATUM_MISSING',
  ROTATION_INVALID: 'properties.georef.check.detail.ROTATION_INVALID',
  ROTATION_NOT_UNIT_LENGTH: 'properties.georef.check.detail.ROTATION_NOT_UNIT_LENGTH',
  TRUE_NORTH_CONTRADICTS_ROTATION: 'properties.georef.check.detail.TRUE_NORTH_CONTRADICTS_ROTATION',
  ORTHOGONAL_HEIGHT_IMPLAUSIBLE: 'properties.georef.check.detail.ORTHOGONAL_HEIGHT_IMPLAUSIBLE',
  SOURCES_DISAGREE: 'properties.georef.check.detail.SOURCES_DISAGREE',
  IFC2X3_NO_EPSET: 'properties.georef.check.detail.IFC2X3_NO_EPSET',
} satisfies Record<GeorefFindingCode, TranslationKey>;

export function findingDetail(finding: GeorefFinding, t: UseTranslationResult['t']): string {
  // An SDK newer than this viewer may introduce a code we do not yet translate.
  if (!Object.hasOwn(DETAIL_KEYS, finding.code)) return finding.message;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(finding.evidence)) {
    if (typeof value === 'number' || typeof value === 'string') params[name] = value;
  }
  params.fields = finding.code === 'SOURCES_DISAGREE'
    ? Object.keys(finding.evidence).filter((key) => key.endsWith('.first')).map((key) => key.slice(0, -6)).join(', ')
    : Object.keys(finding.evidence).join(', ');
  return t(DETAIL_KEYS[finding.code], params);
}
