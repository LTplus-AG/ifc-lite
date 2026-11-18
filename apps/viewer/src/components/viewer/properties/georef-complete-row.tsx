/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The row that completes a half georeference: "Add CRS" when only a map
 * conversion exists, "Add Coordinates" when only a CRS does. Either half
 * alone does not place the model, so an export's "Open georeferencing"
 * (`addGeoref`) lands here as well as on the empty state's add row (#10647).
 */

import { useRef } from 'react';
import { MapPin, Search } from 'lucide-react';
import { TEXT_LINK_CLASS } from '@/components/ui/text-link';
import { useTranslation } from '@/i18n';
import { GEOREF_FOCUS_CLASS, useGeorefSectionFocus } from '@/lib/site-context/georef-section-focus';
import { EpsgLookupDialog, type EpsgResult } from './EpsgLookupDialog';

type GeorefCompleteRowProps = { modelId?: string } & (
  | { missing: 'crs'; onEpsgSelect: (result: EpsgResult) => void }
  | { missing: 'conversion'; onAddCoordinates: () => void }
);

export function GeorefCompleteRow(props: GeorefCompleteRowProps) {
  const { t } = useTranslation();
  const row = useRef<HTMLDivElement>(null);
  useGeorefSectionFocus(props.modelId ?? '', 'addGeoref', row);
  const linkClass = `flex shrink-0 items-center gap-1 text-xs ${TEXT_LINK_CLASS}`;
  return (
    <div ref={row} className={`px-3 py-2 border-b border-border flex items-center gap-2 ${GEOREF_FOCUS_CLASS}`}>
      <span className="text-xs text-muted-foreground flex-1">{t(props.missing === 'crs' ? 'properties.georef.missingCrsNotice' : 'properties.georef.noConversionNotice')}</span>
      {props.missing === 'crs' ? (
        <EpsgLookupDialog onSelect={props.onEpsgSelect}>
          <button className={linkClass}>
            <Search className="h-2.5 w-2.5" />
            {t('properties.georef.addCrs')}
          </button>
        </EpsgLookupDialog>
      ) : (
        <button onClick={props.onAddCoordinates} className={linkClass}>
          <MapPin className="h-2.5 w-2.5" />
          {t('properties.georef.addCoordinates')}
        </button>
      )}
    </div>
  );
}
