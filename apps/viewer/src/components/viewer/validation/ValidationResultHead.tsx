/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source and coverage lines of a validation report on the shared ResultView
 * (#6925), for IDS and rule-set reports alike: the check's name, every model
 * the report validated, the entity–specification population, and how much
 * of the check actually applied. A specification with no applicable
 * elements is called out instead of reading as a pass; an unevaluable one
 * (e.g. a rejected pattern), a capped set check, or a check where no
 * specification applied to anything makes the run partial.
 */

import { useMemo } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { ResultCoverage, ResultSource } from '../result/ResultView';

export function validationSourceName(report: ValidationReport): string {
  return report.source.kind === 'rules' ? report.source.ruleSet.name : report.source.document.info.title;
}

export function ValidationResultSource({ report }: { report: ValidationReport }) {
  const { t, locale } = useTranslation();
  const storeModels = useViewerStore((s) => s.models);
  const models = report.modelInfo.map((m) => ({ id: m.modelId, name: storeModels.get(m.modelId)?.name ?? m.modelId }));
  const population = report.summary.totalEntitiesChecked;
  return (
    <ResultSource
      source={validationSourceName(report)}
      models={models}
      population={t('validationPanel.result.population', { count: population, countDisplay: formatLocaleNumber(locale, population) })}
    />
  );
}

export function ValidationResultCoverage({ report }: { report: ValidationReport }) {
  const { t, locale } = useTranslation();
  const coverage = useMemo(() => {
    const specs = report.specificationResults;
    return {
      total: specs.length,
      applied: specs.filter((spec) => spec.applicableCount > 0 && !spec.error).length,
      notApplicable: specs.filter((spec) => spec.applicableCount === 0 && !spec.error).length,
      unevaluable: specs.filter((spec) => spec.error).length,
      capped: specs.filter((spec) => spec.setResultsTruncated).length,
    };
  }, [report]);
  const number = (value: number) => formatLocaleNumber(locale, value);
  const incomplete = [
    coverage.unevaluable > 0 && t('validationPanel.result.unevaluable', { count: coverage.unevaluable }),
    coverage.capped > 0 && t('validationPanel.result.setsCapped', { count: coverage.capped }),
    coverage.notApplicable > 0 && t('validationPanel.result.notApplicable', { count: coverage.notApplicable }),
  ].filter((line): line is string => typeof line === 'string');
  return (
    <ResultCoverage
      // Nothing applied to anything: no requirement was checked, so the run did not cover the check.
      status={coverage.unevaluable > 0 || coverage.capped > 0 || coverage.applied === 0 ? 'partial' : 'complete'}
      counts={t('validationPanel.result.applied', { applied: number(coverage.applied), total: number(coverage.total) })}
      incomplete={incomplete}
    />
  );
}
