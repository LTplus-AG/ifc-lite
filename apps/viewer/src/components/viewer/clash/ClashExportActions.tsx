/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash panel's export cluster: an in-app BCF topic, plus the shared
 * analysis export split button (#5834) over the BCF archive and the flat CSV
 * table for spreadsheets / BI tools (#3944). The topic is not a file export,
 * so it keeps its own button beside the split button.
 */
import { useState } from 'react';
import { FileBox, FilePlus, Sheet } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { trackExportCompleted } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { exportClashTableCsv } from '@/lib/clash/export-table';
import { ClashBcfExportDialog, type ClashBcfScopeIds } from '@/components/viewer/ClashBcfExportDialog';
import type { ResultScope } from '@/components/viewer/result/ScopeControl';
import { AnalysisExportMenu } from '@/components/viewer/analysis/AnalysisExportMenu';
import { useBcfDraftActions } from '@/components/viewer/bcf/useBcfDraftActions';
import type { Clash } from '@ifc-lite/clash';

const EMPTY_SCOPE: ClashBcfScopeIds = { selected: new Set(), filtered: new Set() };

export interface ClashExportActionsProps {
  /** Id of the selected clash, which scopes the BCF topic to that clash. */
  selectedId: string | null;
  creatingTopic: boolean;
  createBcfTopic: () => Promise<void>;
  /** Findings checked in the list; they can become one reviewed BCF draft topic. */
  selectedClashes?: readonly Clash[];
  /** Ids of the findings the panel's filters show; the archive export can be scoped to them. */
  filteredIds?: readonly string[];
}

export function ClashExportActions({ selectedId, creatingTopic, createBcfTopic, selectedClashes = [], filteredIds = [] }: ClashExportActionsProps) {
  const { t } = useTranslation();
  const { drafting, draftFromSelection } = useBcfDraftActions();
  const [bcfDialogOpen, setBcfDialogOpen] = useState(false);
  // The export's scope is pinned when the dialog opens (#6925): checking or
  // filtering findings afterwards does not change an export being prepared.
  const [scope, setScope] = useState<ResultScope>('all');
  const [scopeIds, setScopeIds] = useState<ClashBcfScopeIds>(EMPTY_SCOPE);
  const openBcfDialog = (): void => {
    setScopeIds({ selected: new Set(selectedClashes.map((clash) => clash.id)), filtered: new Set(filteredIds) });
    setScope('all');
    setBcfDialogOpen(true);
  };
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
      {selectedClashes.length > 0 && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={drafting}
          title={t('bcfDrafts.create.fromSelectionTooltip')} onClick={() => void draftFromSelection(selectedClashes)}>
          {t('bcfDrafts.create.fromSelection', { count: selectedClashes.length })}
        </Button>
      )}
      <AnalysisExportMenu
        formats={[
          {
            id: 'bcf',
            label: t('clashTools.export.formatBcf'),
            title: t('clashTools.export.bcfArchiveTooltip'),
            menuLabel: t('clashTools.export.bcfArchiveMenu'),
            icon: <FileBox />,
            onExport: openBcfDialog,
          },
          {
            id: 'csv',
            label: t('clashTools.export.formatCsv'),
            title: t('clashTools.export.csvTooltip'),
            menuLabel: t('clashTools.export.csvMenu'),
            icon: <Sheet />,
            onExport: exportCsv,
          },
        ]}
      />
      <ClashBcfExportDialog open={bcfDialogOpen} onOpenChange={setBcfDialogOpen} scope={scope} onScopeChange={setScope} scopeIds={scopeIds} />
    </div>
  );
}
