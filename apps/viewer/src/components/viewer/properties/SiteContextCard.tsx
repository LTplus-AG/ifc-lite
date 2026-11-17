/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The site-context card of a context model's metadata panel, modelled on
 * `TerrainImageryCard`: which category this is, whether the core could
 * complete it, the frame it is stated in, every dataset's attribution with
 * its terms link, the aerial imagery once draped, the height assumption when
 * one was made, and every issue the core attached (including the parcel's
 * "terms unverified" caveat), verbatim.
 */

import { useState } from 'react';
import { Mountain } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore, type FederatedModel } from '@/store';
import type { SiteContextModelInfo } from '@/store/slices/siteContextSlice';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-mono text-foreground ml-auto text-right break-all">{value}</span>
    </div>
  );
}

const CATEGORY_KEY = {
  terrain: 'siteContext.category.terrain',
  parcel: 'siteContext.category.parcel',
  buildings: 'siteContext.category.buildings',
} as const;

/** The model's own building found among the neighbours: hidden at load; show or hide it again. */
function SubjectNotice({ modelId, subject }: { modelId: string; subject: NonNullable<SiteContextModelInfo['hiddenSubject']> }) {
  const { t, locale } = useTranslation();
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  const ids = subject.expressIds.map((id) => toGlobalId(modelId, id));
  const hidden = useViewerStore((s) => ids.every((id) => s.hiddenEntities.has(id)));
  const method = subject.method === 'footprint' && subject.overlap !== undefined
    ? t('siteContext.card.subjectMatchFootprint', { overlap: formatLocaleNumber(locale, subject.overlap * 100, { maximumFractionDigits: 0 }) })
    : subject.method === 'egid' ? t('siteContext.card.subjectMatchEgid') : subject.method;
  return (
    <div className="px-3 py-2 space-y-1" data-testid="site-context-subject">
      <p className="text-xs">{t('siteContext.card.subjectHidden', { name: subject.name, method })}</p>
      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs"
        onClick={() => {
          // Routed like every other hide/show channel (#3338), though these ids are the
          // context model's own building features, each carrying its own mesh.
          const s = useViewerStore.getState();
          const targets = resolvePresentationIds(s.cameraCallbacks?.resolveHighlightIds, ids);
          if (hidden) s.showEntities(targets); else s.hideEntities(targets);
        }}>
        {t(hidden ? 'siteContext.card.showSubject' : 'siteContext.card.hideSubject')}
      </Button>
    </div>
  );
}

export function SiteContextCard({ model }: { model: FederatedModel }) {
  const { t, locale } = useTranslation();
  const info = useViewerStore((s) => s.siteContextModels.get(model.id));
  const [draping, setDraping] = useState(false);
  if (!info) return null;
  const drape = async () => {
    setDraping(true);
    try {
      await (await import('@/lib/site-context/site-context-imagery')).drapeSiteContextImagery(model.id);
    } catch (error) {
      console.error('[site-context] imagery drape failed:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDraping(false);
    }
  };
  const number = (value: number) => formatLocaleNumber(locale, value, { maximumFractionDigits: 0, useGrouping: false });
  return (
    <section className="border-b border-border" aria-labelledby={`site-context-card-${model.id}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Mountain className="h-3 w-3 text-muted-foreground" />
        <h4 id={`site-context-card-${model.id}`} className="text-xs font-semibold">{t('siteContext.card.title')}</h4>
      </div>
      <div className="divide-y divide-border">
        <Row label={t('siteContext.card.category')} value={`${t(CATEGORY_KEY[info.kind])} · ${t(info.complete ? 'siteContext.card.complete' : 'siteContext.card.incomplete')}`} />
        <Row label={t('siteContext.card.origin')} value={info.origin.map(number).join(', ')} />
        {info.attribution.map((entry) => (
          <div key={entry.datasetId} className="px-3 py-2 space-y-0.5">
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground shrink-0">{t('siteContext.card.attribution')}</span>
              <span className="text-xs text-foreground ml-auto text-right">{entry.text}</span>
            </div>
            <p className="text-2xs text-muted-foreground">
              {entry.licence}{' · '}
              <a href={entry.termsUrl} target="_blank" rel="noreferrer noopener" className="underline">{t('siteContext.card.terms')}</a>
            </p>
          </div>
        ))}
        {info.imagery && (
          <Row label={t('siteContext.card.imagery')} value={`${info.imagery.attribution.text} · ${t('siteContext.card.imageryGsd', { gsd: formatLocaleNumber(locale, info.imagery.nearGroundSampleDistance ?? info.imagery.groundSampleDistance, { maximumFractionDigits: 2 }) })}${info.imagery.nearGroundSampleDistance ? ` – ${t('siteContext.card.imageryGsd', { gsd: formatLocaleNumber(locale, info.imagery.groundSampleDistance, { maximumFractionDigits: 2 }) })}` : ''}`} />
        )}
        {info.kind === 'terrain' && info.planBox && !info.imagery && (
          <div className="px-3 py-2">
            <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={draping} onClick={() => { void drape(); }}>
              {t('siteContext.card.drape')}
            </Button>
          </div>
        )}
        {info.hiddenSubject && <SubjectNotice modelId={model.id} subject={info.hiddenSubject} />}
        {info.heightAssumed && (
          <p className="border-warn-border bg-warn-surface px-3 py-2 text-xs">{t('siteContext.card.heightAssumed')}</p>
        )}
        {info.issues.length > 0 && (
          <div className="px-3 py-2 space-y-1">
            <span className="text-xs text-muted-foreground">{t('siteContext.card.issues')}</span>
            <ul className="space-y-1">
              {info.issues.map((issue, index) => (
                <li key={`${issue.code}:${index}`} data-issue={issue.code}
                  className={`text-xs ${issue.severity === 'error' ? 'text-error' : issue.severity === 'warning' ? 'text-warn' : 'text-muted-foreground'}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
