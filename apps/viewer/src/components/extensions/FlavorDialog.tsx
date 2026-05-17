/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorDialog` — manage flavors: list, switch, export, import, reset.
 *
 * The export side serialises the active (or selected) flavor to an
 * `.iflv` file via `FlavorService.exportFlavor`. The import side
 * accepts an `.iflv`, previews + validates it, and offers replace /
 * save-as-new strategies. Strategy choice is explicit so users don't
 * silently overwrite a flavor they've been iterating on.
 *
 * Phase 3 scope. The merge UI (T13) lives in a separate component.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §6.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Palette } from 'lucide-react';
import type { Flavor, UnpackedFlavor } from '@ifc-lite/extensions';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import { FlavorMergeDialog } from './FlavorMergeDialog';
import { FlavorListView } from './FlavorListView';
import { FlavorImportPreview } from './FlavorImportPreview';
import * as toastText from './toast-helpers';
import { HelpHint } from './HelpHint';

interface FlavorDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FlavorDialog({ open, onClose }: FlavorDialogProps) {
  const host = useExtensionHost();
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; unpacked: UnpackedFlavor } | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Flavor | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [list, active] = await Promise.all([
      host.flavors.list(),
      host.flavors.getActive(),
    ]);
    setFlavors(list);
    setActiveId(active?.id);
  }, [host]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    return host.flavors.onChange(() => {
      void refresh();
    });
  }, [open, host, refresh]);

  // When the dialog closes (or the preview is dismissed), zero the
  // preview bytes so a sensitive `.iflv` doesn't sit in memory longer
  // than necessary. Best effort — the GC will reclaim eventually.
  useEffect(() => {
    if (open) return;
    if (preview) {
      preview.bytes.fill(0);
      setPreview(null);
    }
    if (mergeTarget) setMergeTarget(null);
  }, [open, preview, mergeTarget]);

  const handleExport = async (id: string) => {
    setBusy(true);
    try {
      const bytes = await host.flavors.exportFlavor(id);
      // Copy into a fresh ArrayBuffer so DOM Blob typings accept it —
      // Uint8Array<ArrayBufferLike> isn't a BlobPart in strict
      // TS lib.dom, and `.slice()` on the underlying buffer may
      // return SharedArrayBuffer.
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id || 'flavor'}.iflv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(toastText.flavorExported(`${id}.iflv`));
    } catch (err) {
      toast.error(toastText.failed('Export', err));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (id: string) => {
    setBusy(true);
    try {
      // Drive the full switcher: enable/disable extensions to match
      // the target flavor, then move the active pointer. Falls back
      // to the bare pointer set on failure so the user can still
      // recover.
      await host.switchFlavor(id);
      toast.success(toastText.flavorSwitched(id));
    } catch (err) {
      toast.error(toastText.failed('Activate', err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete flavor ${id}?`)) return;
    setBusy(true);
    try {
      await host.flavors.delete(id);
      toast.success(toastText.flavorDeleted(id));
    } catch (err) {
      toast.error(toastText.failed('Delete', err));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to baseline flavor? Other flavors are preserved.')) return;
    setBusy(true);
    try {
      await host.flavors.resetToDefaults();
      toast.success(toastText.flavorReset());
    } catch (err) {
      toast.error(toastText.failed('Reset', err));
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.iflv')) {
      toast.error(`Expected a .iflv flavor file, got ${file.name}.`);
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const unpacked = await host.flavors.preview(bytes);
      setPreview({ bytes, unpacked });
    } catch (err) {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleConfirmImport = async (strategy: 'replace' | 'save-as-new') => {
    if (!preview) return;
    setBusy(true);
    try {
      const flavor = await host.flavors.importFlavor(preview.unpacked, { strategy });
      toast.success(toastText.flavorImported(flavor.name));
      setPreview(null);
    } catch (err) {
      toast.error(toastText.failed('Import', err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Flavors
            <HelpHint label="Flavors" popoverClass="left-0">
              <p>
                A <strong>flavor</strong> bundles your installed
                extensions, lenses, saved queries, layout, settings,
                and prompt overlay into a switchable profile.
              </p>
              <p>
                One flavor for cost estimating, another for design
                review. <strong>Switch</strong> deactivates the old
                set and activates the new one.{' '}
                <strong>Export</strong> writes a <code>.iflv</code>{' '}
                you can share. <strong>Import</strong> previews,
                then offers replace / save-as-new / three-way merge.
              </p>
              <p>
                <strong>Reset</strong> restores the empty baseline
                flavor (your other flavors are preserved).
              </p>
            </HelpHint>
          </DialogTitle>
        </DialogHeader>

        {preview ? (
          <FlavorImportPreview
            unpacked={preview.unpacked}
            busy={busy}
            onCancel={() => setPreview(null)}
            onMerge={() => {
              setMergeTarget(preview.unpacked.flavor);
              setPreview(null);
            }}
            onSaveAsNew={() => void handleConfirmImport('save-as-new')}
            onReplace={() => void handleConfirmImport('replace')}
          />
        ) : (
          <>
            <FlavorListView
              flavors={flavors}
              activeId={activeId}
              busy={busy}
              onActivate={(id) => void handleActivate(id)}
              onExport={(id) => void handleExport(id)}
              onDelete={(id) => void handleDelete(id)}
              onImportClick={() => fileInputRef.current?.click()}
              onReset={() => void handleReset()}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".iflv"
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}

        <FlavorMergeDialog
          open={!!mergeTarget}
          theirs={mergeTarget}
          onClose={() => setMergeTarget(null)}
          onMerged={() => void refresh()}
        />
      </DialogContent>
    </Dialog>
  );
}
