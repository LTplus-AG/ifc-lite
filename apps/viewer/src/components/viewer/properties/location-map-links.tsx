/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The location map's footer: open the site in Google Maps / OpenStreetMap,
 * export a Google Earth KMZ, and flip the tile style. Split out of
 * `LocationMap.tsx` (module-size budget) for #8802 R4, which also fixes its
 * layout: each link is one unbreakable unit and the row wraps between links,
 * never inside a label, so a narrow properties panel shows every link whole
 * instead of half-lines cut off at the panel's edge.
 */

import type { ReactNode } from 'react';
import { ExternalLink, Globe2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

const LINK = 'flex items-center gap-1 whitespace-nowrap text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors';

function Tipped({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export interface LocationMapLinksProps {
  googleMapsUrl: string | null;
  openStreetMapUrl: string | null;
  /** The site position comes from model geometry rather than the authored origin. */
  geometryLocation: boolean;
  /** Present when the model can be exported as KMZ. */
  onExportKmz?: () => void;
  /** Absent while no map is shown: flipping the style would be a no-op. */
  onToggleStyle?: () => void;
}

export function LocationMapLinks({ googleMapsUrl, openStreetMapUrl, geometryLocation, onExportKmz, onToggleStyle }: LocationMapLinksProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-t border-border">
      {googleMapsUrl && (
        <Tipped tip={t(geometryLocation ? 'properties.locationMap.geometryGoogleMapsTooltip' : 'properties.locationMap.googleMapsTooltip')}>
          <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            <ExternalLink className="h-2.5 w-2.5" />
            {t('properties.locationMap.googleMaps')}
          </a>
        </Tipped>
      )}
      {openStreetMapUrl && (
        <Tipped tip={t(geometryLocation ? 'properties.locationMap.geometryOpenStreetMapTooltip' : 'properties.locationMap.openStreetMapTooltip')}>
          <a href={openStreetMapUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            <ExternalLink className="h-2.5 w-2.5" />
            {t('properties.locationMap.openStreetMap')}
          </a>
        </Tipped>
      )}
      {onExportKmz && (
        <Tipped tip={t('properties.locationMap.googleEarthTooltip')}>
          <button onClick={onExportKmz} className={LINK}>
            <Globe2 className="h-2.5 w-2.5" />
            {t('properties.locationMap.googleEarth')}
          </button>
        </Tipped>
      )}
      {onToggleStyle && (
        <button onClick={onToggleStyle} className="ml-auto whitespace-nowrap text-xs text-muted-foreground hover:text-foreground transition-colors">
          {t('properties.locationMap.toggleStyle')}
        </button>
      )}
    </div>
  );
}
