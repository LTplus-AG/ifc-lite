/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A manual-validation report block on the preview sheet (#6401): the same
 * heading, overall ring, per-group rings and checks the PDF prints
 * (`compose-manual-report.ts`), as HTML. The rings are the panel's own
 * component, so the preview, the panel and the PDF share one geometry.
 */

import { reportScopeText } from '@/lib/document/report-provenance';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { ManualValidationLegend, ManualValidationRing, VerdictIcon } from '../validation/ManualValidationRing';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS } from './preview-theme';

const VERDICT_LABEL: Record<'pass' | 'fail' | 'warning' | 'unanswered', TranslationKey> = {
  pass: 'manualValidation.verdict.pass',
  fail: 'manualValidation.verdict.fail',
  warning: 'manualValidation.verdict.warning',
  unanswered: 'manualValidation.verdict.unanswered',
};

export function ManualReportPreview({ block }: { block: ManualReportBlock }) {
  const { t } = useTranslation();
  const name = block.checklistName.trim() || t('manualValidation.name.placeholder');
  const percent = block.summary.total > 0 ? Math.floor((block.summary.pass / block.summary.total) * 100) : 0;
  const ink = 'fill-neutral-900';
  const benchmarks = block.benchmarks !== false;
  const detailed = block.variant !== 'compact';

  return (
    <div data-block-manual-report>
      <div className="truncate text-sm font-semibold" title={name}>{t('manualValidation.report.heading', { name })}</div>
      <div className={`text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
        {block.modelName
          ? t('manualValidation.report.recordedAtModel', { model: block.modelName, timestamp: block.generatedAt })
          : t('manualValidation.report.recordedAt', { timestamp: block.generatedAt })}
      </div>
      {reportScopeText(block) && <div className="text-2xs text-neutral-600" data-report-model-scope>{t('validationPanel.history.models', { models: reportScopeText(block) })}</div>}
      {benchmarks && <div className="mt-1 flex items-center gap-3 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5" data-manual-report-benchmarks>
        <ManualValidationRing counts={block.summary} name={t('manualValidation.overall')} size={56} textClassName={ink} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">
            {t('manualValidation.report.passed', { percent, pass: block.summary.pass, total: block.summary.total })}
          </div>
          <ManualValidationLegend counts={block.summary} mutedClassName={DOCUMENT_PREVIEW_MUTED_TEXT_CLASS} />
        </div>
      </div>}
      {block.groups.length === 0 ? (
        <div className="mt-1 rounded border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500">
          {t('manualValidation.report.noGroups')}
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-1" data-manual-report-groups={block.groups.length}>
          {block.groups.map((group) => {
            const groupName = group.name.trim() || t('manualValidation.report.untitledGroup');
            return (
              <section key={group.id} className="rounded border border-neutral-200 px-2 py-1" aria-label={groupName}>
                <div className="flex items-center gap-2">
                  {benchmarks && <ManualValidationRing counts={group.counts} name={groupName} size={20} textClassName={ink} />}
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={groupName}>{groupName}</span>
                  {benchmarks && <span className={`shrink-0 text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
                    {t('manualValidation.group.progress', { answered: group.counts.total - group.counts.unanswered, total: group.counts.total })}
                  </span>}
                </div>
                {group.items.length === 0 ? (
                  <div className="ml-7 text-2xs text-neutral-500">{t('manualValidation.emptyGroup')}</div>
                ) : (
                  <ul className="ml-7 mt-0.5 flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const bucket = item.status ?? 'unanswered';
                      return (
                        <li key={item.id} className="flex gap-2 text-2xs" data-status={bucket}>
                          <span className="inline-flex w-20 shrink-0 items-center gap-1 font-semibold">
                            <VerdictIcon bucket={bucket} className="h-3 w-3" />
                            {t(VERDICT_LABEL[bucket])}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="break-words">{item.text.trim() || t('manualValidation.item.untitled')}</div>
                            {detailed && item.description && <div className="break-words text-neutral-500">{item.description}</div>}
                            {detailed && item.comment && <div className={`whitespace-pre-wrap break-words ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{item.comment}</div>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
