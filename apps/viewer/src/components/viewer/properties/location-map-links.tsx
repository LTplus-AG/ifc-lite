/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The location map's footer: open the site in Google Maps / OpenStreetMap,
 * export a Google Earth KMZ, and flip the tile style. Split out of
 * `LocationMap.tsx` (module-size budget) for #8802 R4, which also fixes its
 * layout: each link is one unbreakable unit, the style flip is an icon with a
 * tooltip, and the row wraps between links, never inside a label. At the
 * default panel width it is one row, so the panel's last line is never a
 * half-line cut off above the status bar.
 */

import type { ReactNode } from 'react';
import { Contrast, ExternalLink, Globe2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

// `min-h-6`: a single-line link is only 16 px tall, under the 24 px target
// minimum (#5826). The 24 px style IconButton already sets the row's height,
// so the taller links do not grow the row.
const LINK = 'flex min-h-6 items-center gap-1 whitespace-nowrap text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors';

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
        <IconButton label={t('properties.locationMap.toggleStyle')} onClick={onToggleStyle} size="icon-xs"
          className="ml-auto h-6 w-6 text-muted-foreground [&_svg]:size-3.5">
          <Contrast />
        </IconButton>
      )}
    </div>
  );
}
