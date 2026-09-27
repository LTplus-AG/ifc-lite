/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSReportExportButton - IDSPanel's report export, on the shared analysis
 * export split button (#5834): HTML, JSON, or BCF. BCF export routes through
 * the controlled `IDSExportDialog`, since it needs a settings step.
 */

import { useState } from 'react';
import { FileBox, FileCode, FileJson } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { ValidationReport } from '@ifc-lite/ids';
import { AnalysisExportMenu } from './analysis/AnalysisExportMenu';
import { IDSExportDialog } from './IDSExportDialog';
import type { IDSBCFExportSettings, IDSExportProgress } from './IDSExportDialog';

interface ReportExportButtonProps {
  onExportJSON: () => void;
  onExportHTML: () => void;
  onExportBCF: (settings: IDSBCFExportSettings) => Promise<void>;
  bcfExportProgress: IDSExportProgress | null;
  report: ValidationReport | null;
}

export function ReportExportButton({
  onExportJSON,
  onExportHTML,
  onExportBCF,
  bcfExportProgress,
  report,
}: ReportExportButtonProps) {
  const { t } = useTranslation();
  const [bcfDialogOpen, setBcfDialogOpen] = useState(false);
  const formats = [
    { id: 'html', label: t('idsPanel.reportExport.format.html'), menuLabel: t('idsPanel.reportExport.htmlReport'), icon: <FileCode className="text-orange-500" />, onExport: onExportHTML },
    { id: 'json', label: t('idsPanel.reportExport.format.json'), menuLabel: t('idsPanel.reportExport.jsonReport'), icon: <FileJson className="text-blue-500" />, onExport: onExportJSON },
    { id: 'bcf', label: t('idsPanel.reportExport.format.bcf'), menuLabel: t('idsPanel.reportExport.bcfReport'), icon: <FileBox className="text-green-500" />, onExport: () => setBcfDialogOpen(true) },
  ].map((format) => ({ ...format, title: t('idsPanel.reportExport.tooltip', { format: format.label }) }));

  return (
    <>
      <AnalysisExportMenu formats={formats} />

      {/* BCF Export Dialog (controlled open) */}
      <IDSExportDialog
        hasReport={!!report}
        failedCount={report?.specificationResults.reduce((sum, s) => sum + s.failedCount, 0) ?? 0}
        specificationResults={report?.specificationResults}
        onExport={onExportBCF}
        progress={bcfExportProgress}
        open={bcfDialogOpen}
        onOpenChange={setBcfDialogOpen}
      />
    </>
  );
}
