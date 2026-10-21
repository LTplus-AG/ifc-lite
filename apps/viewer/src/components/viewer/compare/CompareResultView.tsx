/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison on the shared ResultView (#6925): the A/B models, scope and
 * compared population; a coverage line that says when geometry changes could
 * not be detected; the engine's change counts (products, with type objects
 * as hints, exactly as before); the export bar; the change list; and the
 * selected change's detail as evidence.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { COMPARE_COLORS } from '@/lib/compare/overlay';
import { ALL_COMPARE_RESULTS, type CompareResultFilter } from '@/lib/compare/resultFilter';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { ProductTypeSplit } from '@/lib/compare/productTypeCounts';
import { typeObjectHint } from '@/lib/compare/productTypeCounts';
import { CountBadge } from './CompareResultsList';
import { ResultCoverage, ResultSource, ResultView } from '../result/ResultView';

const SCOPE_KEY: Record<CompareResult['scope'], TranslationKey> = {
  both: 'comparePanel.runControls.scopeBoth',
  data: 'comparePanel.runControls.scopeData',
  geometry: 'comparePanel.runControls.scopeGeometry',
};

interface CompareResultViewProps {
  result: CompareResult | null;
  filter?: CompareResultFilter;
  onFilter?: (filter: CompareResultFilter) => void;
  split: ProductTypeSplit | null;
  /** Elements the content pass matched, when it ran (#1891); null when it did not. */
  matchedElements: number | null;
  exportBar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

export function CompareResultView({ result, filter = ALL_COMPARE_RESULTS, onFilter, split, matchedElements, exportBar, list, detail }: CompareResultViewProps) {
  const { t, locale } = useTranslation();
  const counts = result?.diff.counts;
  const number = (value: number) => formatLocaleNumber(locale, value);
  const header = result && counts ? (() => {
    const changed = counts.added + counts.modified + counts.deleted;
    const compared = changed + counts.unchanged;
    const geometryGap = result.geometryUnavailable && result.scope !== 'data';
    return {
      source: <ResultSource
        source={t('comparePanel.result.source', { scope: t(SCOPE_KEY[result.scope]) })}
        models={[{ id: result.baseModelId, name: result.baseName }, { id: result.headModelId, name: result.headName }]}
        population={t('comparePanel.result.population', { count: compared, countDisplay: number(compared) })}
      />,
      coverage: <ResultCoverage
        status={geometryGap ? 'partial' : 'complete'}
        counts={t('comparePanel.result.counts', { count: changed, countDisplay: number(changed), unchanged: number(counts.unchanged) })}
        incomplete={geometryGap
          ? [t(result.placementOnlyGeometry ? 'comparePanel.result.noShapeChanges' : 'comparePanel.result.noGeometryChanges')]
          : []}
      />,
    };
  })() : null;

  // Counts. The Matched badge appears when the content pass RAN, not when it
  // found something (#1891): added/deleted are lower BECAUSE of it, so the
  // number explaining the drop sits next to them.
  const badge = (category: NonNullable<CompareResultFilter['category']>, label: string, value: number, hint?: string) => (
    <CountBadge label={label} value={value} color={COMPARE_COLORS[category]}
      hint={hint} pressed={filter.category === category}
      onClick={onFilter ? () => onFilter({ category: filter.category === category ? null : category, kind: null }) : undefined} />
  );
  const summary = counts ? (
    <div className={cn('grid gap-1 text-center', matchedElements !== null ? 'grid-cols-5' : 'grid-cols-4')}>
      {badge('modified', t('comparePanel.resultsList.stateChanged'), split?.products.modified ?? counts.modified, typeObjectHint(split?.typeObjects.modified ?? 0))}
      {badge('added', t('comparePanel.resultsList.stateAdded'), split?.products.added ?? counts.added, typeObjectHint(split?.typeObjects.added ?? 0))}
      {badge('deleted', t('comparePanel.resultsList.stateDeleted'), split?.products.deleted ?? counts.deleted, typeObjectHint(split?.typeObjects.deleted ?? 0))}
      {matchedElements !== null && badge('matched', t('comparePanel.matchGroups.matchedLabel'), matchedElements)}
      <CountBadge label={t('comparePanel.panel.countUnchanged')} value={counts.unchanged} color={COMPARE_COLORS.unchanged} />
    </div>
  ) : null;

  return (
    <ResultView
      source={t('comparePanel.panel.title')}

      header={header?.source}
      coverage={header?.coverage}
      summary={summary}
      summaryProps={tourAnchor(TOUR_ANCHORS.compareCounts)}
      filters={result && onFilter ? (
        <div className="px-3 py-2 space-y-2 border-b border-border">
          <p className="text-2xs text-muted-foreground">{t('comparePanel.filters.hint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs flex items-center gap-2">
              {t('comparePanel.filters.kind')}
              <select aria-label={t('comparePanel.filters.kind')} value={filter.kind ?? ''}
                className="min-w-0 rounded border border-border bg-background px-2 py-1"
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === 'data' || kind === 'geometry' || kind === 'container') onFilter({ category: 'modified', kind });
                  else onFilter({ ...filter, kind: null });
                }}>
                <option value="">{t('comparePanel.filters.allKinds')}</option>
                <option value="data">{t('comparePanel.filters.data')}</option>
                <option value="geometry">{t('comparePanel.changeDetail.geometryLabel')}</option>
                <option value="container">{t('comparePanel.filters.container')}</option>
              </select>
            </label>
            <button type="button" onClick={() => onFilter(ALL_COMPARE_RESULTS)}
              disabled={!filter.category && !filter.kind}
              className="text-xs rounded px-2 py-1 hover:bg-muted disabled:opacity-50">
              {t('comparePanel.filters.reset')}
            </button>
          </div>
        </div>
      ) : null}
      actions={exportBar}
      rows={list}
      evidence={detail}
    />
  );
}
