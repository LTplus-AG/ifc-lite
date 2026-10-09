/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Impact of the current comparison on the other loaded analyses (#6921):
 * per source, whether it is loaded, stale, unverified (no run stamp) or
 * absent and how many of its findings name a changed element, then the
 * bounded joined rows. Every number is native (`computeCompareImpact`);
 * nothing is inferred.
 */

import { useState } from 'react';
import '@/i18n/catalogues/review-workspace.register';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ImpactNavigation } from '@/lib/compare/impact-navigation';
import type { ChangedElementRef, CompareImpact, ImpactRow, ImpactSource } from '@/lib/compare/impact';

const SOURCES: readonly ImpactSource[] = ['clash', 'validation', 'list', 'bcf'];
const STATE_KEY = {
  added: 'comparePanel.resultsList.stateAdded',
  deleted: 'comparePanel.resultsList.stateDeleted',
  modified: 'comparePanel.resultsList.stateChanged',
} as const;

function ChangedChips({ changed, row, navigation, onUnavailable }: { changed: readonly ChangedElementRef[]; row: ImpactRow; navigation: ImpactNavigation; onUnavailable: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1">
      {changed.map(c => (
        <button type="button" key={`${c.side}:${c.globalId}`} disabled={!navigation.canSelect(row, c)}
          title={t(navigation.canSelect(row, c) ? 'reviewWorkspace.selectIn3d' : 'reviewWorkspace.selectIn3dNone')}
          onClick={() => { if (!navigation.select(row, c)) onUnavailable(); }} className="rounded bg-muted px-1 text-2xs text-muted-foreground hover:bg-accent disabled:opacity-60 disabled:cursor-not-allowed">
          {t(c.side === 'base' ? 'compareAnalysis.side.base' : 'compareAnalysis.side.head')} · {c.ifcType.replace(/^Ifc/, '')}{' '}
          {c.globalId} · {t(STATE_KEY[c.state])}
        </button>
      ))}
    </span>
  );
}

function RowView({ row, navigation }: { row: ImpactRow; navigation: ImpactNavigation }) {
  const { t, locale } = useTranslation();
  const [unavailable, setUnavailable] = useState(false);
  const number = (value: number) => formatLocaleNumber(locale, value, { maximumFractionDigits: 3 });
  let title: string;
  let detail: string | null = null;
  switch (row.kind) {
    case 'clash':
      title = `${row.rule} · ${row.severity}`;
      detail = row.elements.map(e => `${e.ifcType.replace(/^Ifc/, '')} ${e.globalId}`).join(' × ');
      break;
    case 'validation':
      title = row.specificationName;
      detail = row.failedRequirements.join(', ');
      break;
    case 'list':
      title = t('compareAnalysis.impact.listRow', { name: row.listName, touched: number(row.touchedRows), total: number(row.totalRows) });
      detail = row.columns.map(c => t('compareAnalysis.impact.listColumn',
        { label: c.label, touched: number(c.touchedSum), total: number(c.totalSum) })).join(' · ') || null;
      break;
    case 'bcf':
      title = row.topicStatus ? `${row.title} · ${row.topicStatus}` : row.title;
      break;
  }
  const changed = row.kind === 'validation' ? [row.changed] : row.changed;
  return (
    <li className="rounded border border-border/60 px-2 py-1 space-y-0.5">
      <div className="text-xs font-medium break-words">
        <span className="text-muted-foreground">{t(`compareAnalysis.source.${row.kind}`)}: </span>{title}
      </div>
      {detail && <div className="text-2xs text-muted-foreground break-words">{detail}</div>}
      <button type="button" disabled={!navigation.canOpen(row)} title={!navigation.canOpen(row) ? t('compareAnalysis.impact.navigationUnavailable') : undefined}
        onClick={() => { if (!navigation.open(row)) setUnavailable(true); }}
        className="text-2xs underline underline-offset-2 disabled:opacity-60 disabled:cursor-not-allowed">
        {t('reviewWorkspace.open')}
      </button>
      <ChangedChips changed={changed} row={row} navigation={navigation} onUnavailable={() => setUnavailable(true)} />
      {unavailable && <output className="block text-2xs text-muted-foreground">{t('compareAnalysis.impact.navigationUnavailable')}</output>}
    </li>
  );
}

export function CompareImpactSection({ impact, navigation }: { impact: CompareImpact; navigation: ImpactNavigation }) {
  const { t, locale } = useTranslation();
  const touched = SOURCES.reduce((sum, source) => sum + impact.totals[source], 0);
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">{t('compareAnalysis.impact.summary', { count: impact.changedElements })}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {SOURCES.map(source => {
          const status = impact.sources[source];
          return [
            <dt key={`${source}-t`} className="text-muted-foreground">{t(`compareAnalysis.source.${source}`)}</dt>,
            <dd key={`${source}-d`} className={cn((status === 'stale' || status === 'unverified') && 'text-amber-700 dark:text-amber-400')}>
              {status === 'unavailable' ? t('compareAnalysis.status.unavailable')
                : t(`compareAnalysis.status.${status}`, { count: impact.totals[source] })}
            </dd>,
          ];
        })}
      </dl>
      {impact.unresolvedChanges > 0 && (
        <p className="text-muted-foreground">{t('compareAnalysis.impact.unresolved', { count: impact.unresolvedChanges })}</p>
      )}
      {touched === 0 ? (
        <p className="text-muted-foreground">{t('compareAnalysis.impact.none')}</p>
      ) : (
        <ul className="space-y-1" aria-label={t('compareAnalysis.impact.title')}>
          {impact.rows.map((row, index) => <RowView key={`${row.kind}-${index}`} row={row} navigation={navigation} />)}
        </ul>
      )}
      {impact.rowsTruncated && (
        <p className="text-2xs text-muted-foreground">
          {t('comparePanel.moreNotShown', { count: formatLocaleNumber(locale, impact.totalRows - impact.rows.length) })}
        </p>
      )}
      <p className="text-2xs text-muted-foreground">{t('compareAnalysis.impact.limitations')}</p>
    </div>
  );
}
