/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { ResultView, ResultSource, ResultCoverage } from '../result/ResultView';
import { ResultState } from '../result/ResultState';
import type { useSelectionQuantitySummary } from './measure-modes/use-selection-quantity-summary';

/** Native selection quantities retain their independent bases and withholding reasons (#7184). */
export function QuantityResultView({ quantities, children, evidence }: {
  quantities: ReturnType<typeof useSelectionQuantitySummary>;
  children?: ReactNode;
  evidence?: ReactNode;
}) {
  const { t } = useTranslation();
  const { summary, refs, models, activeModelId } = quantities;
  const source = t('measure.quantities.header');
  const sourceIds = refs.map(ref => {
    // The native engine explicitly uses the single store/geometry slots with no federation map.
    if (models.size === 0) return 'legacy';
    return ref.modelId === 'legacy' && activeModelId && models.has(activeModelId) ? activeModelId : ref.modelId;
  });
  const sourceModels = [...new Set(sourceIds)]
    .map(id => ({ id, name: models.get(id)?.name ?? (id === 'legacy'
      ? t('measure.quantities.singleModelSource') : t('measure.quantities.unavailableModel', { id })) }));
  const incomplete = summary ? [
    ...(summary.withoutStore ? [t('measure.quantities.unresolvedElements', { count: summary.withoutStore })] : []),
    ...(summary.geometry.unproved ? [t('measure.quantities.unprovedVolume', { count: summary.geometry.unproved })] : []),
    ...(summary.rescaled ? [t('measure.quantities.rescaledVolume', { count: summary.rescaled })] : []),
    ...(summary.meshArea.withoutMesh ? [t('measure.quantities.noMeshToMeasure', { count: summary.meshArea.withoutMesh })] : []),
    ...(summary.meshAreaIncomplete ? [t('measure.quantities.meshAreaIncomplete', { count: summary.meshAreaIncomplete })] : []),
    ...(summary.declared.some(row => row.contributing < summary.elements) ? [t('measure.quantities.authoredIncomplete')] : []),
    ...(summary.weights.withheld['no-density'] ? [t('measure.quantities.noDensity', { count: summary.weights.withheld['no-density'] })] : []),
    ...(summary.weights.withheld['density-ambiguous'] ? [t('measure.quantities.densityAmbiguous', { count: summary.weights.withheld['density-ambiguous'] })] : []),
    ...(summary.weights.withheld['weight-unit-is-force'] ? [t('measure.quantities.weightUnitIsForce', { count: summary.weights.withheld['weight-unit-is-force'] })] : []),
  ] : [];
  return <ResultView source={source}
    header={<ResultSource source={source} models={sourceModels}
      population={t('measure.quantities.selectedPopulation', { count: refs.length })} />}
    coverage={summary && <ResultCoverage status={incomplete.length ? 'partial' : 'complete'}
      counts={t('measure.quantities.coverageCounts', { authored: summary.declared.length,
        volumes: summary.geometry.proved, areas: summary.meshArea.withMesh })} incomplete={incomplete} />}
    rows={summary ? children : <ResultState kind="no-population" title={t('measure.quantities.selectPrompt')} />}
    evidence={evidence} />;
}
