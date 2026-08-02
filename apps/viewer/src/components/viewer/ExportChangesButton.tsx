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
import {
  ExportChangesReviewDialog,
  buildReviewGroups,
  type ModelReviewGroup,
} from './ExportChangesReviewDialog';

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

/**
 * Structural equality for two `buildReviewGroups()` outputs (issue: review
 * dialog can diverge from what actually gets exported — every mutating
 * action mutates its `MutablePropertyView` instance in place rather than
 * bumping `mutationVersion` through the store's tracked `set()`, so a
 * mutation made while the review is open can leave the on-screen list stale
 * without React re-rendering it).
 *
 * Deliberately NOT `JSON.stringify(a) === JSON.stringify(b)`: that would be
 * order-sensitive, and while `collectEffectiveChanges` sorts deterministically
 * (entityId, then kind, then name, then setName — see
 * `packages/mutations/src/effective-changes.ts`), a field-by-field walk
 * doesn't lean on that invariant holding forever. Both inputs come from the
 * same `buildReviewGroups()` call site (open-time vs. click-time, or
 * click-time vs. post-export in `handleExport` below), so position-based
 * comparison across the two arrays is valid either way.
 */
function reviewGroupsEqual(a: ModelReviewGroup[], b: ModelReviewGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ga = a[i];
    const gb = b[i];
    if (ga.modelId !== gb.modelId || ga.modelName !== gb.modelName || ga.unitemizedCount !== gb.unitemizedCount) {
      return false;
    }
    if (ga.entities.length !== gb.entities.length) return false;
    for (let j = 0; j < ga.entities.length; j++) {
      const ea = ga.entities[j];
      const eb = gb.entities[j];
      if (ea.entityId !== eb.entityId || ea.label !== eb.label) return false;
      if (ea.changes.length !== eb.changes.length) return false;
      for (let k = 0; k < ea.changes.length; k++) {
        const ca = ea.changes[k];
        const cb = eb.changes[k];
        if (
          ca.entityId !== cb.entityId ||
          ca.kind !== cb.kind ||
          ca.name !== cb.name ||
          ca.setName !== cb.setName ||
          ca.previousValue !== cb.previousValue ||
          ca.newValue !== cb.newValue
        ) {
          return false;
        }
      }
    }
  }
  return true;
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
  // Two-step export (issue #1915): the toolbar button opens a review dialog
  // listing the pending changes; the dialog's own Export button is the
  // confirm step that actually runs `handleExport` below.
  const [reviewOpen, setReviewOpen] = useState(false);

  const changed = useMemo(
    () => collectChangedModels(useViewerStore.getState()),
    // getState() reads the live snapshot; these deps drive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, mutationVersion, georefMutations, scheduleData, scheduleIsEdited, scheduleSourceModelId, legacyIfcDataStore],
  );

  const totalCount = totalChangeCount(changed);
  const modelCount = changed.models.length;

  // Built only while the dialog is open, from the live overlay — this is what
  // the user sees on screen. `handleConfirm` below re-derives this same shape
  // synchronously at click time and compares, to catch a mutation that landed
  // while the review was open without bumping `mutationVersion` (a direct
  // mutation of the same `MutablePropertyView` instance, bypassing the
  // store's tracked `set()`).
  const groups: ModelReviewGroup[] = useMemo(
    () => (reviewOpen ? buildReviewGroups(useViewerStore.getState().mutationViews, changed) : []),
    [reviewOpen, changed],
  );

  const handleExport = useCallback(async (reviewedGroups: ModelReviewGroup[]) => {
    setIsExporting(true);
    setExportStatus('idle');

    try {
      const { files, skipped } = await buildChangedArtifacts(
        useViewerStore.getState(),
        defaultBuildArtifactsDeps,
      );

      // `buildChangedArtifacts` is async and yields to the event loop while it
      // runs (`StepExporter.exportAsync` pauses with `setTimeout(0)` between
      // its progress phases before it reads the overlay) — `handleConfirm`'s
      // `reviewGroupsEqual` check only covers the instant right before this
      // call starts, not the window while it's in flight. A normal, tracked
      // mutation landing in that window (no bypass needed, just an edit made
      // elsewhere while the export runs) would previously ship silently in
      // the produced file with no error and no re-review. Re-derive once more
      // against what was actually reviewed and refuse the same way
      // `handleConfirm` does, rather than hand out a file that may no longer
      // match it.
      const postState = useViewerStore.getState();
      const postGroups = buildReviewGroups(postState.mutationViews, collectChangedModels(postState));
      if (!reviewGroupsEqual(reviewedGroups, postGroups)) {
        setExportStatus('error');
        setTimeout(() => setExportStatus('idle'), 3000);
        toast.error('Changes were made while exporting — check the updated list and confirm again.');
        setReviewOpen(true);
        return;
      }

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

  const handleConfirm = useCallback(() => {
    // Re-derive fresh, synchronously, at click time — comparing against
    // `groups` (what's on screen) so a mutation applied in place while the
    // review was open (not routed through the store's tracked `set()`, so it
    // never bumped `mutationVersion` or re-rendered the dialog) is caught
    // instead of silently exporting a file that no longer matches what the
    // user reviewed.
    const state = useViewerStore.getState();
    const freshChanged = collectChangedModels(state);
    const freshGroups = buildReviewGroups(state.mutationViews, freshChanged);

    if (!reviewGroupsEqual(groups, freshGroups)) {
      toast.error('Changes were made since you opened this review — check the updated list and confirm again.');
      return;
    }

    setReviewOpen(false);
    void handleExport(freshGroups);
  }, [groups, handleExport]);

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
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReviewOpen(true)}
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
      <ExportChangesReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        groups={groups}
        totalCount={totalCount}
        isExporting={isExporting}
        onConfirm={handleConfirm}
      />
    </>
  );
}
