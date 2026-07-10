/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dedicated toolbar button for exporting IFC with pending changes applied.
 * Shows when any loaded model has pending changes and exports ALL of them in
 * one click: a single `.ifc` (or `.ifcx`) when one model changed, or a single
 * zip bundling every changed model's file when several did (issue #1534 — this
 * used to look at only the first federated model for both the badge and the
 * export).
 */

import { useState, useCallback, useMemo } from 'react';
import { Download, Loader2, Check, AlertCircle } from 'lucide-react';
import { zip, strToU8 } from 'fflate';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { downloadFile } from '@/lib/export/download';
import {
  collectChangedModels,
  totalChangeCount,
  buildChangedArtifacts,
  type ArtifactFile,
} from '@/lib/export/model-changes';
import { defaultBuildArtifactsDeps } from '@/lib/export/changed-model-export';

interface ExportChangesButtonProps {
  /** Optional custom class name */
  className?: string;
}

/** YYYY-MM-DD for filenames. */
function formatDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Bundle produced files into a zip off the main thread (fflate async `zip`). */
function zipArtifacts(files: ArtifactFile[]): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    entries[`${f.base}.${f.ext}`] = typeof f.content === 'string' ? strToU8(f.content) : f.content;
  }
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export function ExportChangesButton({ className }: ExportChangesButtonProps) {
  // Subscribe to everything that can change the pending-changes count so the
  // badge stays live. `mutationVersion` bumps on every property / quantity /
  // attribute / georef mutation; schedule edits are watched explicitly.
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const scheduleData = useViewerStore((s) => s.scheduleData);
  const scheduleIsEdited = useViewerStore((s) => s.scheduleIsEdited);
  const scheduleSourceModelId = useViewerStore((s) => s.scheduleSourceModelId);
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);

  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const changed = useMemo(
    () => collectChangedModels(useViewerStore.getState()),
    // getState() reads the live snapshot; these deps drive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, mutationVersion, georefMutations, scheduleData, scheduleIsEdited, scheduleSourceModelId, legacyIfcDataStore],
  );

  const totalCount = totalChangeCount(changed);
  const modelCount = changed.models.length;

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setExportStatus('idle');

    try {
      const { files, skipped } = await buildChangedArtifacts(
        useViewerStore.getState(),
        defaultBuildArtifactsDeps,
      );

      if (files.length === 0) {
        if (skipped.length > 0) {
          setExportStatus('error');
          setTimeout(() => setExportStatus('idle'), 3000);
          toast.error(`Export failed: ${skipped[0].reason}`);
        } else {
          toast.info('No changes to export');
        }
        return;
      }

      const date = formatDate();
      if (files.length === 1) {
        const f = files[0];
        downloadFile(f.content, `${f.base}_${date}.${f.ext}`, f.mime);
      } else {
        const zipped = await zipArtifacts(files);
        downloadFile(zipped, `ifc-lite-changes_${date}.zip`, 'application/zip');
      }

      setExportStatus('success');
      setTimeout(() => setExportStatus('idle'), 2000);

      const exportedChanges = files.reduce((n, f) => n + f.changeCount, 0);
      if (skipped.length > 0) {
        toast.info(
          `Exported ${files.length} of ${files.length + skipped.length} models — ${skipped.length} skipped (${skipped[0].reason})`,
        );
      } else if (files.length === 1) {
        toast.success(`Exported ${files[0].base}.${files[0].ext} (${exportedChanges} changes)`);
      } else {
        toast.success(`Exported ${files.length} models (${exportedChanges} changes)`);
      }
    } catch (error) {
      console.error('[ExportChangesButton] Export failed:', error);
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 3000);
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  }, []);

  // Nothing to export — but keep rendering while an export is in flight so a
  // mid-export clear (count -> 0) doesn't unmount the button and drop state.
  if (totalCount === 0 && !isExporting) {
    return null;
  }

  const tooltip =
    modelCount > 1
      ? `Export changes in ${modelCount} models (${totalCount} changes)`
      : `Export IFC with ${totalCount} change${totalCount === 1 ? '' : 's'} applied`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={isExporting}
          aria-busy={isExporting}
          // Amber = unsaved-changes affordance (matches the app convention used
          // by the Cesium placement editor / ExportDialog dirty marker). The
          // button only renders while changes exist, so it should read as a
          // standing "you have unexported edits" prompt (issue #1107, item 5).
          className={`border-amber-500/60 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 ${className ?? ''}`}
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
          <Badge className="ml-2 text-xs bg-amber-500 text-white border-transparent hover:bg-amber-500">
            {totalCount}
          </Badge>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
