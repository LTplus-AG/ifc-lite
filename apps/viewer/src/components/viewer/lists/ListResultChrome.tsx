/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import type { ListResult } from '@ifc-lite/lists';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { listRunDefinition, listRunModels } from '@/lib/lists/run-provenance';
import { ResultState } from '../result/ResultState';
import { ResultCoverage, ResultSource, ResultView } from '../result/ResultView';
import { useTranslation } from '@/i18n';
import { formatLocaleCount } from './formatLocaleCount';

/** Lists' native matched population is not a count of every entity scanned. */
export function ListResultChrome({ result, visibleCount, filters, actions, children }: {
  result: ListResult; visibleCount: number; filters: ReactNode; actions: ReactNode; children: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const definition = listRunDefinition(result);
  const models = listRunModels(result);
  const stale = useAnalysisStaleness(analysisStampOf(result));
  const source = definition?.name ?? t('lists.resultChrome.sourceUnavailable');
  const incomplete = [
    ...(!definition || !models ? [t('lists.resultChrome.provenanceUnavailable')] : []),
    ...(models?.omittedModels.map(name => t('lists.resultChrome.modelUnavailable', { name })) ?? []),
    ...(visibleCount < result.totalCount ? [t('lists.resultChrome.filtered', { count: result.totalCount - visibleCount })] : []),
  ];
  return <ResultView source={source} className="flex-1 min-h-0"
    header={<ResultSource source={source} models={models?.models ?? []}
      population={t('lists.resultChrome.matched', { count: result.totalCount })} />}
    coverage={<ResultCoverage status={!definition || !models ? 'uncertain' : stale ? 'stale' : models.omittedModels.length ? 'partial' : 'complete'}
      counts={t('lists.resultChrome.visible', { count: visibleCount })} incomplete={incomplete} />}
    summary={<span className="text-xs text-muted-foreground">{t('lists.panel.resultsSummary', {
      count: result.totalCount, countDisplay: formatLocaleCount(result.totalCount, locale), ms: result.executionTime.toFixed(0),
    })}</span>}
    filters={filters} actions={actions} rows={children} />;
}

/** The engine records matches, while only an explicit empty snapshot proves no applicable population. */
export function ListResultEmptyState({ result }: { result: ListResult }) {
  const { t } = useTranslation();
  const kind = result.totalCount > 0 ? 'filtered' : listRunModels(result)?.emptyPopulation ? 'no-population' : 'no-findings';
  return <ResultState kind={kind} title={t(kind === 'filtered' ? 'lists.resultChrome.noVisibleRows'
    : kind === 'no-population' ? 'lists.resultChrome.noPopulation' : 'lists.resultsTable.noRows')} />;
}
