/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeorefFindingCode } from '@ifc-lite/sdk/georef-doctor';
import { georeferencingEn } from './catalogues/georeferencing.en';
import { georeferencingDe } from './locales/de/georeferencing';
import { georeferencingFr } from './locales/fr/georeferencing';
import { georeferencingIt } from './locales/it/georeferencing';
import { georeferencingRu } from './locales/ru/georeferencing';

const codes = {
  NO_GEOREFERENCE: true,
  SITE_LOCATION_ONLY: true,
  SITE_LOCATION_DEFAULT: true,
  SITE_LOCATION_CONTRADICTS_OPERATION: true,
  MAP_POSITION_APPLIED_TWICE: true,
  MAP_COORDINATES_IN_PLACEMENTS: true,
  SCALE_UNIT_MISMATCH: true,
  SCALE_DOES_NOT_BRIDGE_UNITS: true,
  SCALE_INVALID: true,
  EASTING_ZONE_PREFIX: true,
  EASTING_ZONE_PREFIX_MISSING: true,
  LV03_LV95_MIX: true,
  OUTSIDE_CRS_AREA: true,
  CRS_NOT_RESOLVABLE: true,
  OPERATION_WITHOUT_CRS: true,
  CRS_WITHOUT_OPERATION: true,
  MAP_UNIT_MISSING: true,
  VERTICAL_DATUM_MISSING: true,
  ROTATION_INVALID: true,
  ROTATION_NOT_UNIT_LENGTH: true,
  TRUE_NORTH_CONTRADICTS_ROTATION: true,
  ORTHOGONAL_HEIGHT_IMPLAUSIBLE: true,
  SOURCES_DISAGREE: true,
  IFC2X3_NO_EPSET: true,
} satisfies Record<GeorefFindingCode, true>;

it('every doctor finding has a detail template with matching parameters in every locale (#10658)', () => {
  const english: Record<string, unknown> = georeferencingEn;
  for (const [locale, catalogue] of Object.entries({ en: georeferencingEn, de: georeferencingDe, fr: georeferencingFr, it: georeferencingIt, ru: georeferencingRu })) {
    const messages: Record<string, unknown> = catalogue;
    for (const code of Object.keys(codes)) {
      const key = `properties.georef.check.detail.${code}`;
      const value = messages[key];
      assert.equal(typeof value, 'string', `${locale}: ${code}`);
      assert.ok(typeof value === 'string' && value.length > 0);
      const params = (text: unknown) => String(text).match(/\{\w+\}/g)?.sort() ?? [];
      assert.deepEqual(params(value), params(english[key]), `${locale}: ${code} parameters`);
      if (locale !== 'en') assert.notEqual(value, english[key], `${locale}: ${code} translated`);
    }
  }
});
