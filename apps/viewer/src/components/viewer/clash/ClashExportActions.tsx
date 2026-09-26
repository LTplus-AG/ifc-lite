/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash panel's export cluster: BCF topic, BCF archive, and the flat CSV
 * table for spreadsheets / BI tools (#3944). Extracted from `ClashPanel` so the
 * CSV action could be added without growing that file.
 */
import { FilePlus, Sheet } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { trackExportCompleted } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { exportClashTableCsv } from '@/lib/clash/export-table';
import { ClashBcfExportDialog } from '@/components/viewer/ClashBcfExportDialog';

export interface ClashExportActionsProps {
  /** Id of the selected clash, which scopes the BCF topic to that clash. */
  selectedId: string | null;
  creatingTopic: boolean;
  createBcfTopic: () => Promise<void>;
}

export function ClashExportActions({ selectedId, creatingTopic, createBcfTopic }: ClashExportActionsProps) {
  const { t } = useTranslation();
  const exportCsv = (): void => {
    const outcome = exportClashTableCsv();
    if (!outcome) {
      toast.error(t('clashTools.export.noResultsToast'));
      return;
    }
    // Counts only — never model or element names (confidential).
    trackExportCompleted({ format: 'csv', surface: 'clash_results', row_count: outcome.rows });
    toast.success(t('clashTools.export.csvSuccessToast', { count: outcome.rows, filename: outcome.filename }));
  };

  return (
    <div className="ml-auto flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={creatingTopic}
        title={selectedId ? t('clashTools.export.bcfTopicTooltipSelected') : t('clashTools.export.bcfTopicTooltipAll')}
        onClick={() => void createBcfTopic()}
        {...tourAnchor(TOUR_ANCHORS.clashBcf)}
      >
        {creatingTopic ? <Spinner size="sm" className="mr-1" /> : <FilePlus className="h-3.5 w-3.5 mr-1" />}
        {t('clashTools.export.bcfTopicButton')}
      </Button>
      <ClashBcfExportDialog />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        title={t('clashTools.export.csvTooltip')}
        onClick={exportCsv}
      >
        <Sheet className="h-3.5 w-3.5 mr-1" />
        CSV
      </Button>
    </div>
  );
}
