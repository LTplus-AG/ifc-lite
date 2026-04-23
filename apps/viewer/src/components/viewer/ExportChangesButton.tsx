/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dedicated button for exporting IFC with property mutations applied.
 * Shows when there are pending changes and provides one-click export.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download, Loader2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore, countGeneratedTasks } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { toast } from '@/components/ui/toast';
import { ensureModelExportReady } from '@/services/desktop-export';
import { spliceScheduleIntoExport } from '@/sdk/adapters/export-schedule-splice';

interface ExportChangesButtonProps {
  /** Optional custom class name */
  className?: string;
}

function toBlobPart(content: string | Uint8Array): BlobPart {
  if (typeof content === 'string') return content;
  const bytes = new Uint8Array(content.byteLength);
  bytes.set(content);
  return bytes;
}

export function ExportChangesButton({ className }: ExportChangesButtonProps) {
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  // Legacy single-model support
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Get model info - supports both federated models and legacy single-model
  const modelInfo = useMemo(() => {
    // First check federated models
    if (models.size > 0) {
      const firstModel = models.values().next().value;
      if (firstModel) {
        return {
          id: firstModel.id,
          name: firstModel.name,
          ifcDataStore: firstModel.ifcDataStore,
          schemaVersion: firstModel.schemaVersion,
        };
      }
    }
    // Fall back to legacy single-model
    if (legacyIfcDataStore && legacyGeometryResult) {
      return {
        id: '__legacy__',
        name: 'model',
        ifcDataStore: legacyIfcDataStore,
        schemaVersion: legacyIfcDataStore.schemaVersion,
      };
    }
    return null;
  }, [models, legacyIfcDataStore, legacyGeometryResult]);

  // Count mutations (includes georef mutations + pending generated schedule tasks)
  const mutationCount = useMemo(() => {
    if (!modelInfo) return 0;
    const mutationView = getMutationView(modelInfo.id);
    let count = mutationView?.getMutations().length || 0;
    const state = useViewerStore.getState();
    const gm = state.georefMutations?.get(modelInfo.id);
    if (gm) {
      if (gm.projectedCRS) count += Object.keys(gm.projectedCRS).length;
      if (gm.mapConversion) count += Object.keys(gm.mapConversion).length;
    }
    // Generated schedule tasks are first-class pending edits — they get
    // spliced into the STEP on export (see injectScheduleIntoStep), so
    // they belong in the same badge that tells users "you have unsaved
    // work." Attribution: only count when this is the schedule's source
    // model, so the badge doesn't inflate on every federated model.
    if (state.scheduleSourceModelId === modelInfo.id) {
      count += countGeneratedTasks(state.scheduleData);
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelInfo, getMutationView, mutationVersion]);

  // Ensure mutation view exists
  useEffect(() => {
    if (!modelInfo?.ifcDataStore) return;

    let mutationView = getMutationView(modelInfo.id);
    if (mutationView) return;

    const dataStore = modelInfo.ifcDataStore;
    mutationView = new MutablePropertyView(dataStore.properties || null, modelInfo.id);

    configureMutationView(mutationView, dataStore as IfcDataStore);

    registerMutationView(modelInfo.id, mutationView);
  }, [modelInfo, getMutationView, registerMutationView]);

  // Format date as YYYY-MM-DD
  const formatDate = useCallback(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  // Generate filename from model name + date
  const generateFilename = useCallback(() => {
    if (!modelInfo) return 'export.ifc';
    // Remove extension if present
    const baseName = modelInfo.name.replace(/\.[^.]+$/, '');
    return `${baseName}_${formatDate()}.ifc`;
  }, [modelInfo, formatDate]);

  const handleExport = useCallback(async () => {
    if (!modelInfo) return;

    setIsExporting(true);
    setExportStatus('idle');

    try {
      const mutationView = getMutationView(modelInfo.id);
      const exportDataStore = await ensureModelExportReady(modelInfo.id);
      if (!exportDataStore) {
        throw new Error('Model data is unavailable for export');
      }

      // Determine schema version
      const schemaVersion = modelInfo.schemaVersion || 'IFC4';
      const schema = schemaVersion.includes('2X3') ? 'IFC2X3'
                   : schemaVersion.includes('4X3') ? 'IFC4X3'
                   : 'IFC4';

      const exporter = new StepExporter(exportDataStore, mutationView || undefined);
      const state = useViewerStore.getState();
      const georefMutations = state.georefMutations?.get(modelInfo.id) ?? undefined;
      const result = exporter.export({
        schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3',
        includeGeometry: true,
        applyMutations: true,
        deltaOnly: false,
        georefMutations,
        description: `Exported from ifc-lite with ${mutationCount} modifications`,
        application: 'ifc-lite',
      });

      // Splice any pending schedule into the STEP via the shared
      // helper. Same contract every export surface uses so bugs can't
      // differ between the quick button, the dialog, and the SDK.
      const spliced = spliceScheduleIntoExport(result, modelInfo.id, exportDataStore, {
        scheduleData: state.scheduleData ?? null,
        scheduleIsEdited: state.scheduleIsEdited === true,
        scheduleSourceModelId: state.scheduleSourceModelId ?? null,
      });

      // Download the file
      const blob = new Blob([toBlobPart(spliced.content)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generateFilename();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportStatus('success');

      // Reset status after 2 seconds
      setTimeout(() => setExportStatus('idle'), 2000);

      toast.success(`Exported ${result.stats.entityCount} entities (${result.stats.modifiedEntityCount} modified)`);
    } catch (error) {
      console.error('[ExportChangesButton] Export failed:', error);
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 3000);
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  }, [modelInfo, getMutationView, mutationCount, generateFilename]);

  // Don't render if no model or no mutations
  if (!modelInfo || mutationCount === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={isExporting}
          className={className}
        >
          {isExporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : exportStatus === 'success' ? (
            <Check className="h-4 w-4 mr-2 text-green-500" />
          ) : exportStatus === 'error' ? (
            <AlertCircle className="h-4 w-4 mr-2 text-red-500" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Export Changes
          <Badge variant="secondary" className="ml-2 text-xs">
            {mutationCount}
          </Badge>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Export IFC with {mutationCount} property changes applied
      </TooltipContent>
    </Tooltip>
  );
}
