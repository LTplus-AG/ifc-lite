/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type React from 'react';
import { FileText, Upload } from 'lucide-react';
import type { UseIDSResult } from '@/hooks/useIDS';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { loadDemoIdsWithProject } from '@/lib/tours/demo-kit';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { IDSAuditSummary } from './IDSAuditSummary';
import { AnalysisEmptyState } from './analysis/AnalysisEmptyState';
import type { AnalysisProgressState } from './analysis/AnalysisProgress';
import { AnalysisRunButton } from './analysis/AnalysisRunActions';

/** IDS validation progress as the shared analysis progress state (#5834). */
export function idsProgressState(
  progress: NonNullable<UseIDSResult['progress']>,
  t: ReturnType<typeof useTranslation>['t'],
  locale: string,
): AnalysisProgressState {
  const specNumber = Math.min(progress.specificationIndex + 1, progress.totalSpecifications);
  const complete = progress.phase === 'complete';
  const label = complete
    ? t('idsPanel.validationComplete')
    : t('idsPanel.validatingSpecification', {
        current: formatLocaleNumber(locale, specNumber),
        total: formatLocaleNumber(locale, progress.totalSpecifications),
      });
  const detail = progress.phase === 'validating' && progress.totalEntities > 0
    ? t('idsPanel.checkingEntities', { count: progress.totalEntities, processed: formatLocaleNumber(locale, progress.entitiesProcessed), total: formatLocaleNumber(locale, progress.totalEntities) })
    : progress.phase === 'filtering' && progress.totalEntities > 0
      ? t('idsPanel.scanningCandidates', { count: progress.totalEntities, processed: formatLocaleNumber(locale, progress.entitiesProcessed), total: formatLocaleNumber(locale, progress.totalEntities) })
      : progress.phase === 'filtering' ? t('idsPanel.findingApplicable') : null;
  return { label, detail, percent: progress.percentage, complete };
}

interface IDSPanelStatesProps {
  ids: UseIDSResult;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onLoadClick: () => void;
}

export function IDSPanelStates({ ids, fileInputRef, onFileSelect, onLoadClick }: IDSPanelStatesProps) {
  const { t, locale } = useTranslation();
  const { document, report, auditReport, auditing, loading, progress, runValidation, cancelValidation } = ids;
  const validating = loading && progress !== null;
  if (!document) {
    const hasAuditIssues = auditReport !== null && auditReport.issues.length > 0;
    return (
      <div className="flex flex-col h-full p-6">
        {hasAuditIssues && <div className="mb-4"><IDSAuditSummary report={auditReport} auditing={auditing} /></div>}
        <input ref={fileInputRef} type="file" accept=".ids,.xml" className="hidden" onChange={onFileSelect} />
        <AnalysisEmptyState
          className="flex-1"
          icon={<FileText className="size-8" />}
          title={t(hasAuditIssues ? 'idsPanel.documentHasErrors' : 'idsPanel.noIdsLoaded')}
          description={t(hasAuditIssues ? 'idsPanel.fixAndRetry' : 'idsPanel.loadDescription')}
          action={(
            <Button onClick={onLoadClick} {...tourAnchor(TOUR_ANCHORS.idsLoad)}>
              <Upload className="h-4 w-4 mr-2" />
              {t(hasAuditIssues ? 'idsPanel.loadDifferentFile' : 'idsPanel.loadFile')}
            </Button>
          )}
          loadDemo={loadDemoIdsWithProject}
        />
      </div>
    );
  }
  if (report) return null;
  // Audit errors are advisory once the strict parser accepted the document
  // (#5123): real-world IDS files routinely put translated property names
  // into standard Pset_* sets, which the audit flags as
  // E_IFC_PROP_NOT_IN_PSET but the validator checks against the model
  // exactly as written. Keep the issues listed, run the check anyway.
  const auditErrorCount = auditReport?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  return (
    <div className="p-4 space-y-3">
      <div className="rounded-lg border p-4">
        <h3 className="font-medium text-sm mb-1">{document.info.title}</h3>
        {document.info.description && <p className="text-xs text-muted-foreground mb-2">{document.info.description}</p>}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{t('idsPanel.specifications', { count: document.specifications.length, countDisplay: formatLocaleNumber(locale, document.specifications.length) })}</span>
          {document.info.version && <span>{t('idsPanel.version', { version: document.info.version })}</span>}
        </div>
      </div>
      <IDSAuditSummary report={auditReport} auditing={auditing} />
      <AnalysisRunButton
        running={validating}
        busy={loading && !validating}
        onRun={() => { void runValidation(); }}
        onCancel={cancelValidation}
        runLabel={t('idsPanel.runValidation')}
        cancelLabel={t('idsPanel.cancel')}
        {...tourAnchor(TOUR_ANCHORS.idsRun)}
      />
      {auditErrorCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('idsPanel.auditErrorsRunAnyway', { count: auditErrorCount, countDisplay: formatLocaleNumber(locale, auditErrorCount) })}
        </p>
      )}
    </div>
  );
}
