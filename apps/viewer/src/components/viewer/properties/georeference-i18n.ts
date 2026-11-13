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
  const params = { count: names.length, fields: formatLocaleList(locale, names) };
  if (found.scaleForExport !== null) {
    return t('properties.georef.scaleOverrideReason', params);
  }
  return t('properties.georef.scaleOverride', params);
}

export function localizedRawValuesNote(t: Translate, locale: string, found: DoubleGeoreference): string {
  // #9480: no conversion edit bakes this in; see exportCorrectionInstruction.
  if (found.anchorUnitRatio !== null) return t('properties.georef.rawValuesSiteAnchorFix');
  const edits = [
    t('properties.georef.correctionOffsets'),
    t('properties.georef.correctionAngle'),
    ...(found.scaleForExport === null
      ? []
      : [t('properties.georef.correctionScale', { value: formatLocaleNumber(locale, found.scaleForExport, { maximumFractionDigits: 12 }) })]),
  ];
  const params = {
    count: found.factorsForExport.length,
    edits: formatLocaleList(locale, edits),
    factors: formatLocaleList(locale, found.factorsForExport),
  };
  if (found.factorsForExport.length === 0) return t('properties.georef.rawValuesCorrection', params);
  return t('properties.georef.rawValuesCorrectionFactor', params);
}

/**
 * The #9480 note: the IfcSite placement wrote the anchor in the map unit, so
 * the factor is quoted as the larger-than-one ratio between the two units.
 */
export function localizedSiteAnchorUnitNote(t: Translate, locale: string, found: DoubleGeoreference): string | null {
  const ratio = found.anchorUnitRatio;
  if (ratio === null) return null;
  const factor = ratio < 1 ? 1 / ratio : ratio;
  const unit = t('properties.georef.siteAnchorUnitNote', {
    ratio: formatLocaleNumber(locale, factor, { maximumFractionDigits: 4 }),
  });
  const height = found.siteHeightShiftMetres !== null
    ? t('properties.georef.siteAnchorHeightCorrected')
    : t('properties.georef.siteAnchorHeightUncorrected');
  return `${unit} ${height}`;
}
