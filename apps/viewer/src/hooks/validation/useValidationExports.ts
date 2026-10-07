/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON / HTML / BCF export for a `ValidationReport`, generalised over its
 * source (#5138 plan §5/§7: split out of `useIDS.ts`'s "Export Actions"
 * section — `idsExportService.ts` and `idsBcfExport.ts` already read
 * `report.source` rather than assuming an IDS document, so this is a move,
 * not a rewrite).
 */

import { useCallback, useState } from 'react';
import { useViewerStore } from '@/store';
import type { ValidationReport, SupportedLocale } from '@ifc-lite/ids';
import { downloadReportJSON, downloadReportHTML } from '../ids/idsExportService';
import { runIdsBcfExport } from '../ids/idsBcfExport';
import type { IDSBCFExportSettings, IDSExportProgress } from '@/components/viewer/IDSExportDialog';
import { useToViewerGlobalId } from './toViewerGlobalId';
import { useTranslation } from '@/i18n';
import { recordActivity } from '@/lib/activity/activity-journal';

export interface ValidationExportsApi {
  exportReportJSON: () => void;
  exportReportHTML: () => void;
  exportReportBCF: (settings: IDSBCFExportSettings) => Promise<void>;
  bcfExportProgress: IDSExportProgress | null;
}

export function useValidationExports(report: ValidationReport | null, locale: SupportedLocale): ValidationExportsApi {
  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const setBcfPanelVisible = useViewerStore((s) => s.setBcfPanelVisible);
  const setIdsError = useViewerStore((s) => s.setIdsError);
  const toViewerGlobalId = useToViewerGlobalId();
  const { t } = useTranslation();

  const [bcfExportProgress, setBcfExportProgress] = useState<IDSExportProgress | null>(null);

  const exportReportJSON = useCallback(() => {
    if (!report) { console.warn('[Validation] No report to export'); return; }
    downloadReportJSON(report);
  }, [report]);

  const exportReportHTML = useCallback(() => {
    if (!report) { console.warn('[Validation] No report to export'); return; }
    downloadReportHTML(report, locale);
  }, [report, locale]);

  const exportReportBCF = useCallback(async (settings: IDSBCFExportSettings) => {
    if (!report) { console.warn('[Validation] No report to export'); return; }
    try {
      // The IDS dialog runs outside ExportDialogShell; this hook knows the
      // outcome (it reports a failure through `idsError`), so it records the job (#6925).
      await recordActivity({ kind: 'export', title: 'activityTray.job.export', subject: t('activityTray.job.validationBcf') }, () => runIdsBcfExport({
        report, settings, models,
        legacyGeometryResult: geometryResult,
        toViewerGlobalId, bcfAuthor,
        setBcfExportProgress, setBcfProject, setBcfPanelVisible,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'BCF export failed';
      setIdsError(message);
      console.error('[Validation] BCF export error:', err);
      setBcfExportProgress(null);
    }
  }, [report, models, geometryResult, toViewerGlobalId, bcfAuthor, setIdsError, setBcfProject, setBcfPanelVisible, t]);

  return { exportReportJSON, exportReportHTML, exportReportBCF, bcfExportProgress };
}
