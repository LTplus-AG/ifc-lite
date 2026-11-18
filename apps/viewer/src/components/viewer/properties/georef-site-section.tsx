/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcSite RefLatitude / RefLongitude / RefElevation in the Georeference
 * panel (#10659), editable as the SDK's `bim.georef.setSite` writes them
 * (`site-location-write.ts`): one undo step per save.
 *
 * A site without a location needs both coordinates in one write, so a
 * coordinate entered alone is held here until the other one is entered.
 * Shown only for a model with exactly one IfcSite. Mounted through
 * `georef-diagnosis-gate` (`React.lazy`) with the SDK code it uses.
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, Landmark } from 'lucide-react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { readSiteLocation, writeSiteLocation, type SiteLocationAttribute } from '@/lib/geo/site-location-write';
import { GeorefRow } from './georef-rows';

export interface GeorefSiteSectionProps {
  modelId: string;
  editable?: boolean;
}

const ATTRIBUTES: readonly SiteLocationAttribute[] = ['RefLatitude', 'RefLongitude', 'RefElevation'];

export default function GeorefSiteSection({ modelId, editable }: GeorefSiteSectionProps) {
  const { t, locale } = useTranslation();
  const store = useViewerStore((s) => s.models.get(modelId)?.ifcDataStore ?? null);
  const view = useViewerStore((s) => s.mutationViews.get(modelId) ?? null);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Partial<Record<SiteLocationAttribute, number>>>({});
  // mutationVersion: the view's positional edits change in place, so identity alone would not re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const site = useMemo(() => (store ? readSiteLocation(store, view) : null), [store, view, mutationVersion]);

  const save = useCallback((attribute: SiteLocationAttribute, value: string | number) => {
    if (!site || typeof value !== 'number') return;
    const input = { siteId: site.siteId, ...pending, [attribute]: value };
    const outcome = writeSiteLocation(modelId, input);
    if (outcome.ok) {
      setPending({});
      posthog.capture('georeference_set', { method: 'site_field', field: attribute });
    } else if (outcome.code === 'MISSING_INPUT') {
      setPending((held) => ({ ...held, [attribute]: value }));
      toast.info(t('properties.georef.site.needsBoth'));
    } else {
      toast.error(t('properties.georef.site.writeRefused', { message: outcome.message }));
    }
  }, [modelId, pending, site, t]);

  if (!site) return null;
  const shown = (attribute: SiteLocationAttribute) => pending[attribute] ?? site.values[attribute];
  const lat = shown('RefLatitude'), lon = shown('RefLongitude');
  const degrees = (v: number) => `${formatLocaleNumber(locale, v, { maximumFractionDigits: 6 })}°`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-muted text-left transition-colors border-b border-border"
      >
        <ChevronRight className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Landmark className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1 text-left">{t('properties.georef.site.heading')}</span>
        {!open && lat != null && lon != null && (
          <span className="text-xs font-mono text-muted-foreground" data-testid="georef-site-summary">{degrees(lat)}, {degrees(lon)}</span>
        )}
      </button>
      {open && (
        <div className="divide-y divide-border">
          {ATTRIBUTES.map((attribute) => (
            <GeorefRow
              key={attribute}
              label={attribute}
              value={shown(attribute)}
              suffix={attribute === 'RefElevation' ? undefined : '°'}
              isNumber
              editable={editable}
              isMutated={site.edited[attribute] || pending[attribute] !== undefined}
              fieldEntity="ifcSite"
              fieldName={attribute}
              onSave={(v) => save(attribute, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
