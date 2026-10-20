/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function LocationGeoreferenceNotices({ locationKind, geometryDistanceKm, siteDistanceMetres }: {
  locationKind: 'origin' | 'geometry' | null;
  geometryDistanceKm: number | null;
  siteDistanceMetres: number | null;
}) {
  const { t, locale } = useTranslation();
  return <>
    {locationKind === 'geometry' && (
      <p className="px-3 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
        {t('properties.locationMap.geometryLocation')}
      </p>
    )}
    {geometryDistanceKm !== null && (
      <output className="block px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        {t('properties.locationMap.geometryDistance', { value: formatLocaleNumber(locale, geometryDistanceKm) })}
      </output>
    )}
    {siteDistanceMetres !== null && (
      <output className="block px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        {t('properties.locationMap.siteDistance', { value: formatLocaleNumber(locale, siteDistanceMetres) })}
      </output>
    )}
  </>;
}
