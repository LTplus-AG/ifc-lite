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
import { Download, FilePlus, GitMerge, Palette, RefreshCcw, Upload, X } from 'lucide-react';
import type { Flavor, UnpackedFlavor } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import { FlavorMergeDialog } from './FlavorMergeDialog';

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
      toast.success(`Exported ${id}.iflv`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
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
      toast.success(`Switched to ${id}`);
    } catch (err) {
      toast.error(`Activate failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete flavor ${id}?`)) return;
    setBusy(true);
    try {
      await host.flavors.delete(id);
      toast.success(`Deleted ${id}`);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to baseline flavor? Other flavors are preserved.')) return;
    setBusy(true);
    try {
      await host.flavors.resetToDefaults();
      toast.success('Reset to baseline flavor');
    } catch (err) {
      toast.error(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
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
      toast.success(`Imported ${flavor.name}`);
      setPreview(null);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
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
          </DialogTitle>
        </DialogHeader>

        {preview ? (
          <div className="space-y-3">
            <div className="text-sm font-medium">Import preview</div>
            <div className="rounded border bg-muted/30 p-3 text-xs space-y-1">
              <div>
                <span className="text-muted-foreground">Name:</span>{' '}
                <span className="font-medium">{preview.unpacked.flavor.name}</span>
              </div>
              <div>
                <span className="text-muted-foreground">ID:</span>{' '}
                <code className="font-mono">{preview.unpacked.flavor.id}</code>
              </div>
              {preview.unpacked.flavor.description && (
                <div className="text-muted-foreground">{preview.unpacked.flavor.description}</div>
              )}
              <div className="text-muted-foreground">
                {preview.unpacked.flavor.extensions.length} extensions ·{' '}
                {preview.unpacked.flavor.lenses.length} lenses ·{' '}
                {preview.unpacked.flavor.savedQueries.length} queries
              </div>
              {preview.unpacked.summary && (
                <div className="italic text-muted-foreground border-l-2 border-muted pl-2 mt-1">
                  {preview.unpacked.summary}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (!preview) return;
                  setMergeTarget(preview.unpacked.flavor);
                  setPreview(null);
                }}
                disabled={busy}
              >
                <GitMerge className="mr-1 h-3.5 w-3.5" />
                Merge…
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleConfirmImport('save-as-new')}
                disabled={busy}
              >
                <FilePlus className="mr-1 h-3.5 w-3.5" />
                Save as new
              </Button>
              <Button
                size="sm"
                onClick={() => void handleConfirmImport('replace')}
                disabled={busy}
              >
                Replace existing
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Flavors bundle your extensions, lenses, queries, and layout. Switch to
                isolate experiments; export to share or back up.
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void handleReset()} disabled={busy}>
                  <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                  Reset
                </Button>
              </div>
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
            </div>

            {flavors.length === 0 ? (
              <div className="rounded border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
                No flavors yet. Click <span className="font-medium">Reset</span> to create
                the baseline, or <span className="font-medium">Import</span> a `.iflv`.
              </div>
            ) : (
              <ul className="divide-y border rounded">
                {flavors.map((flavor) => {
                  const isActive = flavor.id === activeId;
                  return (
                    <li
                      key={flavor.id}
                      className={`flex items-start gap-3 px-3 py-2 ${isActive ? 'bg-primary/5' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{flavor.name}</span>
                          {isActive && (
                            <span className="text-[10px] uppercase tracking-wide bg-primary/20 text-primary rounded px-1.5 py-0.5 font-semibold">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono break-all">
                          {flavor.id}
                        </div>
                        {flavor.description && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {flavor.description}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {flavor.extensions.length} ext · {flavor.lenses.length} lens ·{' '}
                          {flavor.savedQueries.length} qry · updated{' '}
                          {new Date(flavor.updatedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void handleActivate(flavor.id)}
                            disabled={busy}
                          >
                            Activate
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => void handleExport(flavor.id)}
                          disabled={busy}
                          aria-label={`Export ${flavor.id}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        {!isActive && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => void handleDelete(flavor.id)}
                            disabled={busy}
                            aria-label={`Delete ${flavor.id}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
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
