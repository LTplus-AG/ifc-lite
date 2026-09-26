/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runtime half of the export command registry: the handlers behind the
 * one-click exports (CSV / JSON / screenshot) plus the gating that decides
 * which registry entries are live right now.
 *
 * Both toolbar styles call this hook and render `commands` — the classic strip
 * through `ClassicExportMenuItems`, the ribbon through `RibbonExportGroup` —
 * so the enabled/disabled rule for a format is written once. The dialog-based
 * formats stay dialog components with a `trigger` prop; each style supplies
 * its own trigger element.
 */

import { useCallback, useMemo } from 'react';
import { useIfc } from '@/hooks/useIfc';
import { useChangedModels } from '@/hooks/useUnexportedChanges';
import { totalChangeCount } from '@/lib/export/model-changes';
import { useExtensionExporters } from '@/components/extensions/useExtensionExporters';
import { useViewerStore } from '@/store';
import { buildCommandPaletteJsonEntities } from '../commandPaletteJsonExport';
import { exportCsvFromBytes } from '@/lib/export/csv';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { activeModelName, downloadFile, downloadDataUrl, modelExportFilename } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { trackExportCompleted } from '@/lib/analytics';
import type { UiSurface } from '@/lib/analytics-ui-events';
import { EXPORT_COMMANDS, type CsvExportType, type RegisteredExportCommand } from './export-commands';

export type { CsvExportType };

/** A registry entry plus whether it can run against the current session. */
export interface ResolvedExportCommand {
  command: RegisteredExportCommand;
  disabled: boolean;
}

/** `spatial` is the one table whose type id does not say what the file holds. */
const CSV_SUFFIX: Record<CsvExportType, string> = {
  entities: '_entities',
  properties: '_properties',
  quantities: '_quantities',
  spatial: '_spatial-hierarchy',
};

export function useExportCommands(surface: UiSurface) {
  const { ifcDataStore, models, geometryResult } = useIfc();

  // Same rule as `useFileCommands.hasModelsLoaded`: federated sessions fill
  // `models` and leave the legacy single-model `geometryResult` null.
  const hasModelsLoaded =
    models.size > 0 || Boolean(geometryResult?.meshes && geometryResult.meshes.length > 0);
  const canExport = hasModelsLoaded || Boolean(ifcDataStore);
  // The same live change set the amber Export modified IFC button counts.
  const hasChanges = totalChangeCount(useChangedModels()) > 0;
  const { exporters: extensionExporters, extensionExportRunning, runExtensionExporter } = useExtensionExporters(surface);

  /**
   * The data exports (CSV / JSON) read the single `ifcDataStore` slot, which
   * `setActiveModel` keeps pointed at the ACTIVE model — so in a federated
   * session they cover that one model and none of the others. That predates
   * the registry (it is what `useExportCommands` did on main, and what both
   * toolbars gated on) and making them span the federation is a real change of
   * the output contract: express ids collide across models, so it means either
   * one file per model or a new model column / envelope, which would break
   * anything parsing today's shape. That decision belongs in its own change.
   *
   * What must not survive until then is a PARTIAL export presented as a whole
   * one, so the toast says which it is. The geometry exports (IFC/GLB/KMZ/USD)
   * are unaffected — they go through their own dialogs, which handle the
   * federation themselves.
   */
  const otherModelCount = Math.max(0, models.size - 1);
  const activeModelOnlyNote =
    otherModelCount > 0
      ? ` — active model only, ${otherModelCount} other loaded model${otherModelCount === 1 ? '' : 's'} not included`
      : '';

  const handleExportCSV = useCallback(async (type: CsvExportType) => {
    if (!ifcDataStore || ifcDataStore.source.byteLength <= 0) return;
    try {
      // The model as edited, not the file as loaded (#5397).
      const { activeModelId, getMutationView } = useViewerStore.getState();
      const bytes = editedModelBytes(ifcDataStore, activeModelId ? getMutationView(activeModelId) : null);
      const csv = await exportCsvFromBytes(bytes, type, { includeProperties: type === 'entities' });
      downloadFile(csv, modelExportFilename(activeModelName(useViewerStore.getState()), 'csv', CSV_SUFFIX[type]), 'text/csv');
      trackExportCompleted({ format: 'csv', surface });
      toast.success(`Exported ${type} CSV${activeModelOnlyNote}`);
    } catch (err) {
      console.error('CSV export failed:', err);
      toast.error(`CSV export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore, activeModelOnlyNote, surface]);

  const handleExportJSON = useCallback(() => {
    if (!ifcDataStore) return;
    try {
      // One row builder for both JSON exports; the model as edited (#5249).
      const { activeModelId, getMutationView } = useViewerStore.getState();
      const entities = buildCommandPaletteJsonEntities(ifcDataStore, activeModelId ? getMutationView(activeModelId) : null);

      const json = JSON.stringify({ entities }, null, 2);
      downloadFile(json, modelExportFilename(activeModelName(useViewerStore.getState()), 'json', '_data'), 'application/json');
      trackExportCompleted({ format: 'json', surface, row_count: entities.length });
      toast.success(`Exported ${entities.length} entities as JSON${activeModelOnlyNote}`);
    } catch (err) {
      console.error('JSON export failed:', err);
      toast.error(`JSON export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore, activeModelOnlyNote, surface]);

  const handleScreenshot = useCallback(() => {
    // The 3D viewport's canvas, not merely the first on the page (#5601).
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    try {
      if (!canvas) throw new Error('no 3D viewport canvas on screen');
      downloadDataUrl(canvas.toDataURL('image/png'), modelExportFilename(activeModelName(useViewerStore.getState()), 'png', '_screenshot'));
      trackExportCompleted({ format: 'png', surface });
      toast.success('Screenshot saved');
    } catch (err) {
      console.error('Screenshot failed:', err);
      toast.error('Screenshot failed');
    }
  }, [surface]);

  /** Dispatch for the registry's one-click (`kind: 'action'`) commands. */
  const runExportAction = useCallback((action: 'json' | 'screenshot') => {
    if (action === 'json') handleExportJSON();
    else handleScreenshot();
  }, [handleExportJSON, handleScreenshot]);

  const commands = useMemo<ResolvedExportCommand[]>(
    () => EXPORT_COMMANDS.map((command) => ({
      command,
      disabled: command.requires === 'dataStore' ? !ifcDataStore
        : command.requires === 'changes' ? !hasChanges
        : !canExport,
    })),
    [ifcDataStore, canExport, hasChanges],
  );

  return {
    ifcDataStore,
    canExport,
    commands,
    handleExportCSV,
    handleExportJSON,
    handleScreenshot,
    runExportAction,
    /** The registry's runtime half: installed extension exporters (#5838). */
    extensionExporters,
    /** One extension export at a time: every extension row is disabled while one runs. */
    extensionExportRunning,
    runExtensionExporter,
  };
}
