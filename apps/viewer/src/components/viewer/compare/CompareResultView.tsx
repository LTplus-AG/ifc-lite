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
  split: ProductTypeSplit | null;
  /** Elements the content pass matched, when it ran (#1891); null when it did not. */
  matchedElements: number | null;
  exportBar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

export function CompareResultView({ result, split, matchedElements, exportBar, list, detail }: CompareResultViewProps) {
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
        counts={t('comparePanel.result.counts', { changed: number(changed), unchanged: number(counts.unchanged) })}
        incomplete={geometryGap
          ? [t(result.placementOnlyGeometry ? 'comparePanel.result.noShapeChanges' : 'comparePanel.result.noGeometryChanges')]
          : []}
      />,
    };
  })() : null;

  // Counts. The Matched badge appears when the content pass RAN, not when it
  // found something (#1891): added/deleted are lower BECAUSE of it, so the
  // number explaining the drop sits next to them.
  const summary = counts ? (
    <div className={cn('grid gap-1 text-center', matchedElements !== null ? 'grid-cols-5' : 'grid-cols-4')}>
      <CountBadge label={t('comparePanel.resultsList.stateChanged')} value={split?.products.modified ?? counts.modified}
        color={COMPARE_COLORS.modified} hint={typeObjectHint(split?.typeObjects.modified ?? 0)} />
      <CountBadge label={t('comparePanel.resultsList.stateAdded')} value={split?.products.added ?? counts.added}
        color={COMPARE_COLORS.added} hint={typeObjectHint(split?.typeObjects.added ?? 0)} />
      <CountBadge label={t('comparePanel.resultsList.stateDeleted')} value={split?.products.deleted ?? counts.deleted}
        color={COMPARE_COLORS.deleted} hint={typeObjectHint(split?.typeObjects.deleted ?? 0)} />
      {matchedElements !== null && (
        <CountBadge label={t('comparePanel.matchGroups.matchedLabel')} value={matchedElements} color={COMPARE_COLORS.matched} />
      )}
      <CountBadge label={t('comparePanel.panel.countUnchanged')} value={counts.unchanged} color={COMPARE_COLORS.unchanged} />
    </div>
  ) : null;

  return (
    <ResultView
      source={t('comparePanel.panel.title')}
      className="flex-1 min-h-0"
      header={header?.source}
      coverage={header?.coverage}
      summary={summary}
      summaryProps={tourAnchor(TOUR_ANCHORS.compareCounts)}
      actions={exportBar}
      rows={list}
      evidence={detail}
    />
  );
}
