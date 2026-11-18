/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Georeference panel of a model with no georeferencing: the "Add
 * georeferencing" row when the model can take one, the read-only reason when
 * it cannot, and always the Site context and Surface runoff sections, which
 * say what they need. Before #10603 this state rendered the add row alone (or
 * nothing at all when not editable), so the sections a palette command
 * pointed at did not exist and nothing said why.
 */

import { useRef } from 'react';
import { GEOREF_FOCUS_CLASS, useGeorefSectionFocus } from '@/lib/site-context/georef-section-focus';
import { Globe } from 'lucide-react';
import type { GeoreferenceInfo } from '@ifc-lite/parser';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { EpsgLookupDialog, type EpsgResult } from './EpsgLookupDialog';
import { GeorefReadOnlyNotices } from './georef-notices';
import { SiteContextSection } from '../site-context/SiteContextSection';
import { FloodCheckSection } from '../site-context/FloodCheckSection';

export function GeorefEmptyState({ georef, modelId, editable, schemaNotice, onEpsgSelect }: {
  georef: GeoreferenceInfo | null | undefined;
  modelId: string | undefined;
  editable: boolean;
  /** The schema cannot carry standard georeferencing (the panel's own notice says so). */
  schemaNotice: boolean;
  onEpsgSelect: (result: EpsgResult) => void;
}) {
  const { t } = useTranslation();
  const addRow = useRef<HTMLDivElement>(null);
  useGeorefSectionFocus(modelId ?? '', 'addGeoref', addRow);
  return (
    <div>
      <div ref={addRow} tabIndex={-1} className={GEOREF_FOCUS_CLASS}>
        {editable ? (
          <div className="px-3 py-1.5 flex items-center gap-2">
            <Globe className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground flex-1">{t('properties.georef.noGeoreferencing')}</span>
            <EpsgLookupDialog onSelect={onEpsgSelect}>
              <Button type="button" variant="outline" size="segment" className="min-h-6 gap-1 px-1.5 text-xs [&_svg]:size-2.5">
                <Globe />
                {t('properties.georef.addGeoreferencing')}
              </Button>
            </EpsgLookupDialog>
          </div>
        ) : schemaNotice ? (
          <GeorefReadOnlyNotices georef={georef} schemaNotice />
        ) : (
          <div className="px-3 py-1.5 flex items-center gap-2">
            <Globe className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{t('properties.georef.noGeoreferencing')}</span>
          </div>
        )}
      </div>
      {modelId && <SiteContextSection modelId={modelId} editable={editable} />}
      {modelId && <FloodCheckSection key={modelId} modelId={modelId} />}
    </div>
  );
}
