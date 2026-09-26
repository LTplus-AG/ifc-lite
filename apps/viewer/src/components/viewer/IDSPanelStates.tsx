/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type React from 'react';
import { FileText, Play, Square, Upload } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { UseIDSResult } from '@/hooks/useIDS';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { IDSAuditSummary } from './IDSAuditSummary';

export function IDSValidationProgress({ progress }: { progress: NonNullable<UseIDSResult['progress']> }) {
  const { t, locale } = useTranslation();
  const specNumber = Math.min(progress.specificationIndex + 1, progress.totalSpecifications);
  const isComplete = progress.phase === 'complete';
  const headline = isComplete
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
  return (
    <div className="p-3 border-b">
      <div className="flex items-center gap-2 mb-1">
        {!isComplete && <Spinner size="md" className="shrink-0" />}
        <span className="text-sm font-medium tabular-nums">{headline}</span>
      </div>
      {detail && <div className="text-xs text-muted-foreground mb-2 tabular-nums">{detail}</div>}
      <Progress value={progress.percentage} className="h-2" />
    </div>
  );
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
        <div className="flex flex-col items-center justify-center flex-1 text-center">
          <FileText className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="font-medium text-sm mb-2">{t(hasAuditIssues ? 'idsPanel.documentHasErrors' : 'idsPanel.noIdsLoaded')}</h3>
          <p className="text-xs text-muted-foreground mb-4">{t(hasAuditIssues ? 'idsPanel.fixAndRetry' : 'idsPanel.loadDescription')}</p>
          <input ref={fileInputRef} type="file" accept=".ids,.xml" className="hidden" onChange={onFileSelect} />
          <Button onClick={onLoadClick} {...tourAnchor(TOUR_ANCHORS.idsLoad)}>
            <Upload className="h-4 w-4 mr-2" />
            {t(hasAuditIssues ? 'idsPanel.loadDifferentFile' : 'idsPanel.loadFile')}
          </Button>
        </div>
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
      <Button className="w-full" onClick={validating ? cancelValidation : () => { void runValidation(); }} disabled={loading && !validating} {...tourAnchor(TOUR_ANCHORS.idsRun)}>
        {validating ? <Square className="h-4 w-4 mr-2" /> : loading ? <Spinner size="md" className="mr-2" /> : <Play className="h-4 w-4 mr-2" />}
        {t(validating ? 'idsPanel.cancel' : 'idsPanel.runValidation')}
      </Button>
      {auditErrorCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('idsPanel.auditErrorsRunAnyway', { count: auditErrorCount, countDisplay: formatLocaleNumber(locale, auditErrorCount) })}
        </p>
      )}
    </div>
  );
}
