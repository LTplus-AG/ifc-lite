/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data-export commands (CSV / JSON / screenshot) shared by the classic
 * toolbar and the ribbon. The dialog-based exporters (IFC, GLB, KMZ,
 * HBJSON) stay as dialog components with a `trigger` prop — each
 * toolbar style supplies its own trigger element.
 */

import { useCallback } from 'react';
import { useIfc } from '@/hooks/useIfc';
import { exportCsvFromBytes } from '@/lib/export/csv';
import { downloadFile, downloadDataUrl } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';

export type CsvExportType = 'entities' | 'properties' | 'quantities' | 'spatial';

export function useExportCommands() {
  const { ifcDataStore } = useIfc();

  const handleExportCSV = useCallback(async (type: CsvExportType) => {
    if (!ifcDataStore?.source) return;
    try {
      const csv = await exportCsvFromBytes(ifcDataStore.source, type, { includeProperties: type === 'entities' });
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

  return { ifcDataStore, handleExportCSV, handleExportJSON, handleScreenshot };
}
