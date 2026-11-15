/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Site context" in the Georeference panel: shown for a model whose
 * georeference resolves inside Switzerland. The user picks a radius, the
 * categories and whether to drape aerial imagery, and clicks "Load site
 * context"; nothing is fetched before that click. Each category then loads
 * as its own federated model, toggled from the hierarchy like any model.
 */

import { useEffect, useState } from 'react';
import { Mountain, X } from 'lucide-react';
import type { SiteContextLayerKind } from '@ifc-lite/site-context';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatFileSize } from '@/lib/recent-files';
import { SITE_CONTEXT_CATEGORIES, SITE_CONTEXT_RADII, type SiteContextCategoryStatus, type SiteContextRadius } from '@/store/slices/siteContextSlice';
import { resolveSiteContextAnchor, type SiteContextAnchor } from '@/lib/site-context/site-context-anchor';

const CATEGORY_KEY = {
  terrain: 'siteContext.category.terrain',
  parcel: 'siteContext.category.parcel',
  buildings: 'siteContext.category.buildings',
} as const satisfies Record<SiteContextLayerKind, string>;

const STATUS_KEY = {
  idle: 'siteContext.status.idle',
  fetching: 'siteContext.status.fetching',
  partial: 'siteContext.status.partial',
  done: 'siteContext.status.done',
  error: 'siteContext.status.error',
} as const satisfies Record<SiteContextCategoryStatus, string>;

/** Resolve the anchor whenever the model or its georeference changes. */
function useAnchor(modelId: string): SiteContextAnchor | null {
  const model = useViewerStore((s) => s.models.get(modelId));
  const mutations = useViewerStore((s) => s.georefMutations.get(modelId));
  const [anchor, setAnchor] = useState<SiteContextAnchor | null>(null);
  useEffect(() => {
    let live = true;
    void resolveSiteContextAnchor(modelId).then(
      (resolved) => { if (live) setAnchor(resolved); },
      (error: unknown) => { console.warn('[site-context] anchor resolution failed:', error); if (live) setAnchor(null); },
    );
    return () => { live = false; };
  }, [modelId, model, mutations]);
  return anchor;
}

export function SiteContextSection({ modelId }: { modelId: string }) {
  const { t, locale } = useTranslation();
  const anchor = useAnchor(modelId);
  const isContextModel = useViewerStore((s) => s.siteContextModels.has(modelId));
  const categories = useViewerStore((s) => s.siteContextCategories);
  const progress = useViewerStore((s) => s.siteContextProgress);
  const running = useViewerStore((s) => s.siteContextAbort !== null);
  const stats = useViewerStore((s) => s.siteContextStats);
  const error = useViewerStore((s) => s.siteContextError);
  const { addModel, removeModel } = useIfc();
  // The last request's choices survive the panel closing and reopening (it remounts).
  const last = useViewerStore.getState().siteContextRequest;
  const [radius, setRadius] = useState<SiteContextRadius>(last?.radius ?? 200);
  const [selected, setSelected] = useState<ReadonlySet<SiteContextLayerKind>>(new Set(last?.categories ?? ['terrain', 'parcel']));
  const [imagery, setImagery] = useState(last?.imagery ?? true);

  // A site-context model is the context, not a site to fetch around; outside
  // Switzerland the section has nothing to offer and stays out of the way.
  if (isContextModel || !anchor || (!anchor.ok && anchor.reason === 'outside-switzerland')) return null;

  const start = () => {
    if (!anchor.ok) return;
    void import('@/lib/site-context/site-context-fetch').then(({ loadSiteContext }) => loadSiteContext({
      anchorModelId: modelId, centre: anchor.centre, radius, categories: SITE_CONTEXT_CATEGORIES.filter((kind) => selected.has(kind)),
      imagery: imagery && selected.has('terrain'), addModel, removeModel,
    }));
  };
  const toggle = (kind: SiteContextLayerKind, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(kind); else next.delete(kind);
    setSelected(next);
  };

  return (
    <section aria-labelledby={`site-context-${modelId}`} className="border-t border-border px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <Mountain className="h-3 w-3 text-muted-foreground shrink-0" />
        <h4 id={`site-context-${modelId}`} className="text-xs font-semibold text-foreground">{t('siteContext.section.title')}</h4>
      </div>
      {!anchor.ok ? (
        <p className="text-xs text-warn">
          {anchor.reason === 'height-datum'
            ? t('siteContext.refusal.heightDatum', { datum: anchor.detail ?? '' })
            : anchor.reason === 'unknown-crs'
              ? t('siteContext.refusal.unknownCrs', { crs: anchor.detail ?? '' })
              : t('siteContext.refusal.notGeoreferenced')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('siteContext.section.intro')}</p>
          <SegmentedControl
            label={t('siteContext.section.radius')} size="sm" value={String(radius)} disabled={running}
            options={SITE_CONTEXT_RADII.map((value) => ({ value: String(value), label: t('siteContext.section.radiusValue', { radius: value }) }))}
            onValueChange={(value) => setRadius(Number(value) as SiteContextRadius)}
          />
          <fieldset className="space-y-1" disabled={running}>
            <legend className="text-xs text-muted-foreground">{t('siteContext.section.categories')}</legend>
            {SITE_CONTEXT_CATEGORIES.map((kind) => (
              <div key={kind} className="flex items-center gap-2">
                <Checkbox checked={selected.has(kind)} onCheckedChange={(on) => toggle(kind, on)} label={t(CATEGORY_KEY[kind])} />
                {categories[kind] && (
                  <span className="ml-auto text-xs text-muted-foreground" data-status={categories[kind]!.status}>{t(STATUS_KEY[categories[kind]!.status])}</span>
                )}
              </div>
            ))}
            <Checkbox checked={imagery && selected.has('terrain')} disabled={!selected.has('terrain')} onCheckedChange={setImagery} label={t('siteContext.section.imagery')} />
          </fieldset>
          {anchor.crsAssumedFromName && <p className="text-xs text-muted-foreground">{t('siteContext.section.crsAssumed', { crs: anchor.crsAssumedFromName })}</p>}
          {anchor.heightAssumed && <p className="text-xs text-warn">{t('siteContext.section.heightAssumed')}</p>}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={running || selected.size === 0} onClick={start}>
              <Mountain className="h-3 w-3" />{t('siteContext.section.load')}
            </Button>
            {running && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => useViewerStore.getState().abortSiteContextRequest()}>
                <X className="h-3 w-3" />{t('siteContext.section.cancel')}
              </Button>
            )}
          </div>
          {progress && <output className="block text-xs text-muted-foreground">{progress.message}</output>}
          {error && <p className="text-xs text-error">{error}</p>}
          {stats && (
            <p className="text-xs text-muted-foreground">
              {t('siteContext.section.stats', {
                requests: formatLocaleNumber(locale, stats.requests), size: formatFileSize(stats.bytes),
                seconds: formatLocaleNumber(locale, stats.elapsedMs / 1000, { maximumFractionDigits: 1 }),
                cacheHits: formatLocaleNumber(locale, stats.cacheHits),
              })}
            </p>
          )}
          <p className="text-2xs text-muted-foreground">{t('siteContext.section.privacy')}</p>
        </>
      )}
    </section>
  );
}
