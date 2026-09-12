/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash panel's export cluster: BCF topic, BCF archive, and the flat CSV
 * table for spreadsheets / BI tools (#3944). Extracted from `ClashPanel` so the
 * CSV action could be added without growing that file.
 */
import { FilePlus, Loader2, Sheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
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
  const exportCsv = (): void => {
    const outcome = exportClashTableCsv();
    if (!outcome) {
      toast.error('No clash results to export');
      return;
    }
    // Counts only — never model or element names (confidential).
    posthog.capture('export_completed', { format: 'csv', surface: 'clash_results', row_count: outcome.rows });
    toast.success(`Exported ${outcome.rows} clash${outcome.rows === 1 ? '' : 'es'} to ${outcome.filename}`);
  };

  return (
    <div className="ml-auto flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={creatingTopic}
        title={selectedId ? 'Create a BCF topic from the selected clash' : 'Create a BCF topic for this clash report'}
        onClick={() => void createBcfTopic()}
        {...tourAnchor(TOUR_ANCHORS.clashBcf)}
      >
        {creatingTopic ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FilePlus className="h-3.5 w-3.5 mr-1" />}
        BCF topic
      </Button>
      <ClashBcfExportDialog />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        title="Download every clash in this run as a CSV table — one row per clash with both GlobalIds, review status and storey — for Excel / Power BI"
        onClick={exportCsv}
      >
        <Sheet className="h-3.5 w-3.5 mr-1" />
        CSV
      </Button>
    </div>
  );
}
