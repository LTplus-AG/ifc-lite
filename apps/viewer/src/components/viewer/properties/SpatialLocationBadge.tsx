/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { InspectorRow } from './inspector-ui';

export interface SpatialLocationInfo {
  storeyName: string;
  elevation?: number;
  height?: number;
}

/** The selected entity's containing storey, with elevation/height readouts.
 *  Extracted out of PropertiesPanel.tsx as a plain presentational sibling —
 *  it owns no state of its own, it only renders `spatialInfo`. */
export function SpatialLocationBadge({ spatialInfo }: { spatialInfo: SpatialLocationInfo | null }) {
  const { t, locale } = useTranslation();
  if (!spatialInfo) return null;
  const fmt = (value: number) => formatLocaleNumber(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Neutral key/value rows (#8802): the storey, then its elevation and height
  // each under their own label so no number is left unexplained.
  return (
    <>
      <InspectorRow label={t('properties.spatialLocation.storeyLabel')} value={spatialInfo.storeyName} />
      {spatialInfo.elevation !== undefined && (
        <InspectorRow
          label={t('properties.spatialLocation.elevationLabel')}
          value={t('properties.spatialLocation.elevationDisplay', { sign: spatialInfo.elevation >= 0 ? '+' : '', value: fmt(spatialInfo.elevation) })}
          mono
          copy={false}
        />
      )}
      {spatialInfo.height !== undefined && (
        <InspectorRow
          label={t('properties.spatialLocation.heightLabel')}
          value={t('properties.spatialLocation.heightDisplay', { value: fmt(spatialInfo.height) })}
          mono
          copy={false}
        />
      )}
    </>
  );
}
