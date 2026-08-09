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
import { exportCsvFromBytes } from '@/lib/export/csv';
import { downloadFile, downloadDataUrl } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { EXPORT_COMMANDS, type CsvExportType, type RegisteredExportCommand } from './export-commands';

export type { CsvExportType };

/** A registry entry plus whether it can run against the current session. */
export interface ResolvedExportCommand {
  command: RegisteredExportCommand;
  disabled: boolean;
}

export function useExportCommands() {
  const { ifcDataStore, models, geometryResult } = useIfc();

  // Same rule as `useFileCommands.hasModelsLoaded`: federated sessions fill
  // `models` and leave the legacy single-model `geometryResult` null.
  const hasModelsLoaded =
    models.size > 0 || Boolean(geometryResult?.meshes && geometryResult.meshes.length > 0);
  const canExport = hasModelsLoaded || Boolean(ifcDataStore);

  const handleExportCSV = useCallback(async (type: CsvExportType) => {
    if (!ifcDataStore || ifcDataStore.source.byteLength <= 0) return;
    try {
      const csv = await exportCsvFromBytes(ifcDataStore.source.materialize(), type, { includeProperties: type === 'entities' });
      const filename = type === 'spatial' ? 'spatial-hierarchy.csv' : `${type}.csv`;
      downloadFile(csv, filename, 'text/csv');
      toast.success(`Exported ${type} CSV`);
    } catch (err) {
      console.error('CSV export failed:', err);
      toast.error(`CSV export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore]);

  const handleExportJSON = useCallback(() => {
    if (!ifcDataStore) return;
    try {
      const entities: Record<string, unknown>[] = [];
      for (let i = 0; i < ifcDataStore.entities.count; i++) {
        const id = ifcDataStore.entities.expressId[i];
        entities.push({
          expressId: id,
          globalId: ifcDataStore.entities.getGlobalId(id),
          name: ifcDataStore.entities.getName(id),
          type: ifcDataStore.entities.getTypeName(id),
          properties: ifcDataStore.properties.getForEntity(id),
        });
      }

      const json = JSON.stringify({ entities }, null, 2);
      downloadFile(json, 'model-data.json', 'application/json');
      toast.success(`Exported ${entities.length} entities as JSON`);
    } catch (err) {
      console.error('JSON export failed:', err);
      toast.error(`JSON export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore]);

  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    try {
      downloadDataUrl(canvas.toDataURL('image/png'), 'screenshot.png');
      toast.success('Screenshot saved');
    } catch (err) {
      console.error('Screenshot failed:', err);
      toast.error('Screenshot failed');
    }
  }, []);

  /** Dispatch for the registry's one-click (`kind: 'action'`) commands. */
  const runExportAction = useCallback((action: 'json' | 'screenshot') => {
    if (action === 'json') handleExportJSON();
    else handleScreenshot();
  }, [handleExportJSON, handleScreenshot]);

  const commands = useMemo<ResolvedExportCommand[]>(
    () => EXPORT_COMMANDS.map((command) => ({
      command,
      disabled: command.requires === 'dataStore' ? !ifcDataStore : !canExport,
    })),
    [ifcDataStore, canExport],
  );

  return {
    ifcDataStore,
    canExport,
    commands,
    handleExportCSV,
    handleExportJSON,
    handleScreenshot,
    runExportAction,
  };
}
