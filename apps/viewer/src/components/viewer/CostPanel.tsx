/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CostPanel — read-only IFC 5D cost inspector (#4858, parent #4322).
 *
 * Consumes the merged read model (#4863 `packages/parser/src/cost-evaluator.ts`)
 * and its SDK/viewer surface (#4867 `apps/viewer/src/sdk/adapters/cost-adapter.ts`)
 * exactly as scripting's `bim.cost` does — no cost arithmetic, currency
 * handling, or cycle detection is reimplemented here.
 *
 * Read-only by design: every action below either selects something in the
 * viewport or reads a value. Nothing here mutates cost data — spreadsheet
 * editing is explicitly out of scope for this issue.
 *
 * Selection is federation-safe: a clicked product/task ref carries its own
 * `modelId` (from `getAssignedTargets`, `lib/cost/cost-tree.ts`) and is
 * translated to a renderer global id via the store's own `toGlobalId`
 * (FederationRegistry-backed) before it reaches the 3D selection channels —
 * never treated as a bare expressId that could collide across models.
 *
 * Teardown: this panel holds no cache of its own — `useCostModels` recomputes
 * straight from the live `models` Map every render. `selectedRef` is a bare
 * ref, never trusted on its own: `selectedEntry` looks it up fresh in the
 * CURRENT `entries` every render, so the instant a model is removed (or
 * "open another model" replaces it), that lookup finds nothing and the
 * `selectedEntry?.graph` guard below falls through to the empty-selection
 * prompt — the detail pane can never render a stale cross-model reference,
 * with no separate effect required to "clear" anything (mutation-tested:
 * an explicit clear-on-removal effect here was provably redundant against
 * this same guard).
 */

import { Coins, Download, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { buildCostCsvReport } from '@/lib/analysis/export-csv';
import type { EntityRefLike } from '@/lib/cost/cost-tree';
import { downloadFile } from '@/lib/export/download';
import { trackExportCompleted } from '@/lib/analytics';
import { CostDetail } from './cost/CostDetail';
import { CostTreeView } from './cost/CostTreeView';
import { useCostBackend } from './cost/useCostBackend';
import { useCostModels } from './cost/useCostModels';

export interface CostPanelProps {
  onClose?: () => void;
}

export function CostPanel({ onClose }: CostPanelProps) {
  const { t } = useTranslation();
  const entries = useCostModels();
  const backend = useCostBackend();
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  const clearEntitySelection = useViewerStore((s) => s.clearEntitySelection);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntities = useViewerStore((s) => s.setSelectedEntities);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const addEntitiesToSelection = useViewerStore((s) => s.addEntitiesToSelection);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);

  const [selectedRef, setSelectedRef] = useState<EntityRefLike | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = useCallback(() => {
    try {
      const report = buildCostCsvReport(entries, backend.evaluateItem);
      if (!report) return;
      downloadFile(report.content, report.filename, 'text/csv;charset=utf-8');
      trackExportCompleted({ format: 'csv', surface: 'cost_panel', row_count: report.rows });
      setExportError(null);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  }, [entries, backend]);

  const handleSelectItem = useCallback((_modelId: string, ref: EntityRefLike) => {
    setSelectedRef(ref);
  }, []);

  const handleSelectTargets = useCallback(
    (refs: EntityRefLike[]) => {
      if (refs.length === 0) return;
      // Two-channel selection (see AGENTS.md): global ids drive 3D
      // highlight/pick, {modelId, expressId} refs drive the properties
      // panel — both must be set, and both must go through toGlobalId so a
      // federated session's per-model offset is applied, never a bare
      // expressId that could collide with another loaded model's.
      // Every multi-target channel carries ALL targets (the same replace
      // sequence as useEntityListMultiSelect's selectExact), with the first
      // target as primary; never collapse to a single-entity setter, which
      // clears `selectedEntities`.
      const globalIds = refs.map((r) => toGlobalId(r.modelId, r.expressId));
      clearEntitySelection();
      setSelectedEntityIds(globalIds);
      setSelectedEntityId(globalIds[0]);
      addEntitiesToSelection(refs);
      setSelectedEntities(refs);
      if (cameraCallbacks.frameSelection) {
        window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
      }
    },
    [toGlobalId, clearEntitySelection, setSelectedEntityIds, setSelectedEntityId, addEntitiesToSelection, setSelectedEntities, cameraCallbacks],
  );

  const selectedEntry = selectedRef ? entries.find((e) => e.modelId === selectedRef.modelId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Coins className="h-4 w-4 text-amber-600" />
        <span className="flex-1 text-sm font-medium">{t('costPanel.title')}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={handleExport}
          disabled={!entries.some((entry) => (entry.graph?.CostItems.length ?? 0) > 0)}>
          <Download className="h-3.5 w-3.5" /> {t('costPanel.exportCsv')}
        </Button>
        {onClose && (
          <IconButton label={t('costPanel.close')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {exportError && <div role="alert" className="px-3 py-1 text-xs text-destructive">{exportError}</div>}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 overflow-y-auto border-r">
          <CostTreeView entries={entries} selectedRef={selectedRef} onSelectItem={handleSelectItem} />
        </div>
        <div className="w-1/2 overflow-y-auto">
          {selectedRef && selectedEntry?.graph ? (
            <CostDetail
              graph={selectedEntry.graph}
              itemRef={selectedRef}
              backend={backend}
              onSelectTargets={handleSelectTargets}
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">{t('costPanel.selectPrompt')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
