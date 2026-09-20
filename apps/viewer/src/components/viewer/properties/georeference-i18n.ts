/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { useTranslation } from '@/i18n';
import { formatLocaleList, formatLocaleNumber } from '@/i18n/intlFormat';
import type { DoubleGeoreference } from '@/lib/geo/double-georeference';

type Translate = ReturnType<typeof useTranslation>['t'];

export function localizedApproxDistance(t: Translate, locale: string, metres: number): string {
  if (!Number.isFinite(metres)) return t('properties.georef.distanceUnknown');
  if (metres > 100_000_000) return t('properties.georef.distancePlanetWidth');
  if (metres >= 1000) {
    return t('properties.georef.distanceKilometres', { value: formatLocaleNumber(locale, Math.round(metres / 1000)) });
  }
  return t('properties.georef.distanceMetres', { value: formatLocaleNumber(locale, Math.round(metres)) });
}

export function localizedScaleOverride(t: Translate, locale: string, found: DoubleGeoreference): string | null {
  const names = [...(found.scaleForExport !== null ? ['Scale'] : []), ...found.factorsForExport];
  if (names.length === 0) return null;
  const params = { fields: formatLocaleList(locale, names) };
  if (found.scaleForExport !== null) {
    return t(names.length === 1 ? 'properties.georef.scaleOverrideReasonOne' : 'properties.georef.scaleOverrideReasonOther', params);
  }
  return t(names.length === 1 ? 'properties.georef.scaleOverrideOne' : 'properties.georef.scaleOverrideOther', params);
}

export function localizedRawValuesNote(t: Translate, locale: string, found: DoubleGeoreference): string {
  const edits = [
    t('properties.georef.correctionOffsets'),
    t('properties.georef.correctionAngle'),
    ...(found.scaleForExport === null
      ? []
      : [t('properties.georef.correctionScale', { value: formatLocaleNumber(locale, found.scaleForExport, { maximumFractionDigits: 12 }) })]),
  ];
  const params = {
    edits: formatLocaleList(locale, edits),
    factors: formatLocaleList(locale, found.factorsForExport),
  };
  if (found.factorsForExport.length === 0) return t('properties.georef.rawValuesCorrection', params);
  return t(
    found.factorsForExport.length === 1
      ? 'properties.georef.rawValuesCorrectionFactorOne'
      : 'properties.georef.rawValuesCorrectionFactorOther',
    params,
  );
}
