/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { extractSiteRefLocationOnDemand, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { siteRefMismatchMetres } from '@/lib/geo/site-ref-mismatch';
import { localizedApproxDistance } from './georeference-i18n';

interface SiteRefMismatchNoticeProps {
  modelId: string;
  crs: ProjectedCRS | undefined;
  conversion: MapConversion | undefined;
  lengthUnitScale?: number;
}

/** Warns when IfcSite RefLatitude/RefLongitude and the MapConversion position disagree (#7658). */
export function SiteRefMismatchNotice({ modelId, crs, conversion, lengthUnitScale }: SiteRefMismatchNoticeProps) {
  const { t, locale } = useTranslation();
  const dataStore = useViewerStore(s => s.models.get(modelId)?.ifcDataStore);
  const site = useMemo(() => (dataStore ? extractSiteRefLocationOnDemand(dataStore) : null), [dataStore]);
  const [mismatch, setMismatch] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    siteRefMismatchMetres(site, conversion, crs, lengthUnitScale)
      .then(metres => { if (!cancelled) setMismatch(metres); })
      .catch((error: unknown) => console.warn('[georef] IfcSite reference comparison failed', error));
    return () => { cancelled = true; };
  }, [site, conversion, crs, lengthUnitScale]);

  if (mismatch === null) return null;
  return (
    <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 bg-amber-50/60 dark:bg-amber-950/25">
      <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="leading-snug">
          {t('properties.georef.siteRefMismatch', { distance: localizedApproxDistance(t, locale, mismatch) })}
        </span>
      </div>
    </div>
  );
}
