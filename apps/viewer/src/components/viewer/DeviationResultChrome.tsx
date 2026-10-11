/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { formatLocaleNumber, useTranslation } from '@/i18n';
import { deviationSourceOf } from '@/lib/point-cloud/deviation-source';
import type { PointCloudDeviationStatistics } from '@/lib/point-cloud/deviation-run-statistics';
import { ResultCoverage, ResultSource, ResultView } from './result/ResultView';
import { ResultState } from './result/ResultState';
import { DeviationSummary } from './DeviationStatistics';

/** Readback population is a count of scan points, never IFC entities or GPU scene models (#7197). */
export function DeviationResultChrome({ statistics, distancesPresent, tolerance, onToleranceChange, actions, filters, children }: {
  statistics: PointCloudDeviationStatistics | null;
  distancesPresent: boolean;
  tolerance: number;
  onToleranceChange: (metres: number) => void;
  actions: ReactNode;
  filters: ReactNode;
  children: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const stale = useAnalysisStaleness(analysisStampOf(statistics));
  const source = statistics ? deviationSourceOf(statistics) : null;
  const summary = statistics?.overall;
  const unknownAssets = source?.filter(asset => !asset.modelId || !asset.modelName).length ?? 0;
  const unknownEntities = source?.filter(asset => asset.modelId && (!asset.globalId || asset.expressId === null)).length ?? 0;
  const models = [...new Map((source ?? []).flatMap(asset => asset.modelId && asset.modelName
    ? [[asset.modelId, { id: asset.modelId, name: asset.modelName }] as const] : [])).values()];
  const unmeasured = summary ? summary.count - summary.validCount : 0;
  const unknownSource = !source || source.length === 0;
  const incomplete = [
    ...(!statistics ? [t('deviationStats.reading')] : []),
    ...(statistics && unknownSource ? [t('deviationStats.sourceUnknown')] : []),
    ...(unknownAssets ? [t('deviationStats.assetSourceUnknown', { count: unknownAssets })] : []),
    ...(unknownEntities ? [t('deviationStats.assetIdentityUnknown', { count: unknownEntities })] : []),
    ...(unmeasured ? [t('deviationStats.unmeasuredPoints', { count: unmeasured })] : []),
    ...(summary?.clippedCount ? [t('deviationStats.clippedPoints', { count: summary.clippedCount,
      countDisplay: formatLocaleNumber(locale, summary.clippedCount), clip: formatLocaleNumber(locale, statistics?.clipRange ?? 0) })] : []),
    ...(summary && summary.validCount === 0 ? [t('deviationStats.noMeasuredPoints')] : []),
  ];
  const name = t('deviationStats.resultSource');
  return <ResultView source={name}
    header={<ResultSource source={name} models={models} population={summary
      ? t('deviationStats.readbackPopulation', { count: summary.count, countDisplay: formatLocaleNumber(locale, summary.count) }) : undefined} />}
    coverage={<ResultCoverage status={!statistics ? 'running' : unknownSource ? 'uncertain' : stale ? 'stale'
      : unmeasured || unknownAssets || unknownEntities || summary?.clippedCount || summary?.validCount === 0 ? 'partial' : 'complete'}
      counts={summary ? t('deviationStats.validPopulation', { count: summary.validCount,
        countDisplay: formatLocaleNumber(locale, summary.validCount), total: formatLocaleNumber(locale, summary.count) }) : t('deviationStats.reading')}
      incomplete={incomplete} />}
    summary={statistics || distancesPresent ? <DeviationSummary statistics={statistics} tolerance={tolerance}
      onToleranceChange={onToleranceChange} toleranceEditable={distancesPresent} /> : undefined}
    filters={filters} actions={actions}
    rows={<>{summary?.validCount === 0 && <ResultState kind="partial" title={t('deviationStats.noMeasuredPoints')} />}{children}</>}
    evidence={source && source.length > 0 ? <ul aria-label={t('deviationStats.sourceAssets')} className="text-2xs space-y-1">
      {source.map((asset, index) => <li key={index}>
        {asset.modelName ?? t('deviationStats.unknownAsset')} · {t('deviationStats.assetGlobalId')}: {asset.globalId ?? t('deviationStats.notAvailable')}
        {asset.ifcClass ? ` · ${asset.ifcClass}` : ''}{asset.name ? ` · ${asset.name}` : ''}
      </li>)}
    </ul> : undefined} />;
}
