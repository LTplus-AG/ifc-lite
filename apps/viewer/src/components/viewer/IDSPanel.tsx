/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSPanel - IDS (Information Delivery Specification) validation panel
 *
 * Provides:
 * - Load IDS files
 * - Run validation against loaded models
 * - View validation results with pass/fail status
 * - Filter by specification, status
 * - Click to select entities in 3D view
 * - Isolate failed/passed entities
 * - Multi-language support (EN/DE/FR)
 */

import React, { useCallback, useState, useMemo, useRef, useEffect } from 'react';
import { AlertCircle, FileText, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIDS } from '@/hooks/useIDS';
import { openGenericFileDialog } from '@/services/file-dialog';
import { useViewerStore } from '@/store';
import { endIdsRowFocusPresentation } from '@/lib/ids/visibility-ownership';
import { IDSCorrectionDialog } from './IDSCorrectionDialog';
import { useTranslation } from '@/i18n';
import { IDSPanelResults } from './IDSPanelResults';
import { IDSPanelStates, IDSValidationProgress } from './IDSPanelStates';

// ============================================================================
// Types
// ============================================================================

interface IDSPanelProps {
  onClose?: () => void;
}
// ============================================================================
// Main Panel Component
// ============================================================================

export function IDSPanel({ onClose }: IDSPanelProps) {
  const { t, locale } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ids = useIDS();
  const {
    // State
    document,
    report,
    loading,
    progress,
    error,
    // Actions
    loadIDSFile,
    clearIDS,
    runValidation,
    clearValidation,
    focusEntity,
  } = ids;

  // Validation runs against one model at a time. When a federation is loaded,
  // surface which model the results reflect and let the user switch (#1591).
  const idsMultiModel = useViewerStore((s) => s.models.size > 1);
  // Full model list for the target-model picker (federation): lets the user
  // see which model the results reflect and switch to validate another one.
  const idsModels = useViewerStore((s) => s.models);
  // Only offer models that actually carry parsed IFC data. Geometry-only,
  // mid-load or cache-restored models have no `ifcDataStore` and cannot be
  // validated — listing them would let the user pick a model whose report
  // would silently reflect a different model's data (#1702 C1).
  const idsModelList = useMemo(
    () => Array.from(idsModels.values()).filter((m) => m.ifcDataStore != null),
    [idsModels],
  );

  // The controlled picker binds to the landed report's model id, which only
  // updates once a run completes. Hold the user's in-flight choice locally so
  // the dropdown keeps showing the model being validated instead of snapping
  // back to the previous one while `loading` (#1702 C3).
  // Leaving the panel ends the ROW focus presentation (#2867): an isolate- or
  // ghost-mode focus would otherwise leave the model isolated on, or faded
  // around, an element whose panel is gone — the same reason `ClashPanel` has
  // an unmount cleanup. Ownership-scoped, so a presentation belonging to
  // clash, the spaces X-ray or IDS's own set-level isolate buttons is left
  // exactly as the user left it.
  useEffect(() => () => {
    endIdsRowFocusPresentation(useViewerStore.getState());
  }, []);

  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  useEffect(() => {
    // Once a run settles (report landed or errored), fall back to the report's
    // own model id so the picker reflects reality again.
    if (!loading) setPendingModelId(null);
  }, [loading]);

  // Which specification's "Correct Property" dialog is open, if any (#3929).
  const [correctionSpecId, setCorrectionSpecId] = useState<string | null>(null);
  const correctionSpecResult = report?.specificationResults.find(
    (s) => s.specification.id === correctionSpecId
  );

  // Handle file selection
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await loadIDSFile(file);
    }
    // Reset input for re-selection of same file
    e.target.value = '';
  }, [loadIDSFile]);

  const loadIdsFromDialog = useCallback(async (): Promise<boolean> => {
    const file = await openGenericFileDialog({
      title: t('idsPanel.openFileTitle'),
      filters: [
        { name: t('idsPanel.idsFiles'), extensions: ['ids', 'xml'] },
        { name: t('idsPanel.allFiles'), extensions: ['*'] },
      ],
    });
    if (file) {
      await loadIDSFile(file);
      return true;
    }
    return false;
  }, [loadIDSFile, t, locale]);

  const handleLoadIdsClick = useCallback(async () => {
    const loaded = await loadIdsFromDialog();
    if (loaded) {
      return;
    }
    fileInputRef.current?.click();
  }, [loadIdsFromDialog]);

  // Handle entity click. The row's focus MODE (highlight / isolate / ghost) is
  // the user's persistent choice, applied by `focusEntity` — activating a row
  // used to select, colour nothing extra and frame, which in a dense model
  // left the element indistinguishable from the failures around it (#2867).
  const handleEntityClick = useCallback((modelId: string, expressId: number) => {
    focusEntity(modelId, expressId);
  }, [focusEntity]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <span className="font-medium text-sm">{t('idsPanel.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Load New IDS */}
          {document && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ids,.xml"
                className="hidden"
                onChange={handleFileSelect}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    aria-label={t('idsPanel.loadNew')}
                    onClick={() => { void handleLoadIdsClick(); }}
                  >
                    <Upload className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('idsPanel.loadNew')}</TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Clear */}
          {document && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={t('idsPanel.clear')}
                  onClick={() => {
                    clearIDS();
                    clearValidation();
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('idsPanel.clear')}</TooltipContent>
            </Tooltip>
          )}

          {/* Close */}
          {onClose && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t('idsPanel.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{typeof error === 'string' ? error : t(error.labelKey, error.params)}</span>
          </div>
        </div>
      )}

      {/* Progress */}
      {loading && progress && <IDSValidationProgress progress={progress} />}

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        <IDSPanelStates
          ids={ids}
          fileInputRef={fileInputRef}
          onFileSelect={handleFileSelect}
          onLoadClick={() => { void handleLoadIdsClick(); }}
        />
        <IDSPanelResults
          ids={ids}
          multiModel={idsMultiModel}
          models={idsModelList}
          pendingModelId={pendingModelId}
          setPendingModelId={setPendingModelId}
          onEntityClick={handleEntityClick}
          onCorrect={setCorrectionSpecId}
        />
      </div>

      {report && correctionSpecResult && (
        <IDSCorrectionDialog
          open={correctionSpecId != null}
          onOpenChange={(open) => { if (!open) setCorrectionSpecId(null); }}
          specResult={correctionSpecResult}
          modelId={report.modelInfo.modelId}
          onRevalidate={runValidation}
        />
      )}
    </div>
  );
}
