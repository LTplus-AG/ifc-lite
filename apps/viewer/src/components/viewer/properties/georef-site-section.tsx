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
import { Landmark } from 'lucide-react';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { readSiteLocation, writeSiteLocation, type SiteLocationAttribute } from '@/lib/geo/site-location-write';
import { GeorefRow } from './georef-rows';
import { INSPECTOR_COUNT, InspectorSectionTrigger } from './inspector-ui';

export interface GeorefSiteSectionProps {
  modelId: string;
  editable?: boolean;
}

const NOTHING_HELD: Partial<Record<SiteLocationAttribute, number>> = {};
const ATTRIBUTES: readonly SiteLocationAttribute[] = ['RefLatitude', 'RefLongitude', 'RefElevation'];

export default function GeorefSiteSection({ modelId, editable }: GeorefSiteSectionProps) {
  const { t, locale } = useTranslation();
  const store = useViewerStore((s) => s.models.get(modelId)?.ifcDataStore ?? null);
  const view = useViewerStore((s) => s.mutationViews.get(modelId) ?? null);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [open, setOpen] = useState(false);
  // A held coordinate belongs to one model's site; it is dropped when the panel shows another.
  const [held, setHeld] = useState({ owner: '', values: NOTHING_HELD });
  // mutationVersion: the view's positional edits change in place, so identity alone would not re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const site = useMemo(() => (store ? readSiteLocation(store, view) : null), [store, view, mutationVersion]);
  const owner = site ? `${modelId}#${site.siteId}` : '';
  const pending = held.owner === owner ? held.values : NOTHING_HELD;

  const save = useCallback((attribute: SiteLocationAttribute, value: string | number) => {
    if (!site || typeof value !== 'number') return;
    const input = { siteId: site.siteId, ...pending, [attribute]: value };
    const outcome = writeSiteLocation(modelId, input);
    if (outcome.ok) {
      setHeld({ owner: '', values: NOTHING_HELD });
      posthog.capture('georeference_set', { method: 'site_field', field: attribute });
    } else if (outcome.code === 'MISSING_INPUT') {
      setHeld({ owner, values: { ...pending, [attribute]: value } });
      toast.info(t('properties.georef.site.needsBoth'));
    } else {
      toast.error(t('properties.georef.site.writeRefused', { message: outcome.message }));
    }
  }, [modelId, owner, pending, site, t]);

  if (!site) return null;
  const shown = (attribute: SiteLocationAttribute) => pending[attribute] ?? site.values[attribute];
  const lat = shown('RefLatitude'), lon = shown('RefLongitude');
  const degrees = (v: number) => `${formatLocaleNumber(locale, v, { maximumFractionDigits: 6 })}°`;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border">
      <InspectorSectionTrigger
        icon={<Landmark className="h-3 w-3 text-muted-foreground shrink-0" />}
        title={t('properties.georef.site.heading')}
        trailing={!open && lat != null && lon != null
          ? <span className={INSPECTOR_COUNT} data-testid="georef-site-summary">{degrees(lat)}, {degrees(lon)}</span>
          : undefined}
      />
      <CollapsibleContent>
        <div className="divide-y divide-border border-t border-border">
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
      </CollapsibleContent>
    </Collapsible>
  );
}
