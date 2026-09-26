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

import { trackExportCompleted } from '@/lib/analytics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Palette } from 'lucide-react';
import type { Flavor, UnpackedFlavor } from '@ifc-lite/extensions';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { downloadFile } from '@/lib/export/download';
import { FlavorMergeDialog } from './FlavorMergeDialog';
import { FlavorListView } from './FlavorListView';
import { FlavorImportPreview } from './FlavorImportPreview';
import { flavorFailure, flavorSwitchPartial } from './flavor-dialog-feedback';
import { HelpHint } from './HelpHint';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { captureClashConfig } from './flavor-dialog-capture';
import { localizedFlavorName } from './localized-flavor-metadata';

interface FlavorDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FlavorDialog({ open, onClose }: FlavorDialogProps) {
  const { t, locale } = useTranslation();
  const host = useExtensionHost();
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; unpacked: UnpackedFlavor } | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Flavor | null>(null);
  /** Live lens count from the viewer store — drives the "N new lenses
   *  not yet in active flavor" banner. */
  const liveLensCount = useViewerStore((s) => s.savedLenses.length);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failure = (operation: string, err: unknown) => flavorFailure(t, operation, err);

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
      // downloadFile copies the (possibly ArrayBufferLike / Shared) bytes into a
      // fresh ArrayBuffer-backed view, so DOM Blob typings accept them.
      downloadFile(bytes, `${id || 'flavor'}.iflv`, 'application/octet-stream');
      trackExportCompleted({ format: 'iflv', surface: 'extension_panel' });
      toast.success(t('extensionsFlavors.flavorDialog.toast.exported', { filename: `${id}.iflv` }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.export'), err));
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
      const outcome = await host.switchFlavor(id);
      // The switch can land while parts of the flavor's saved state do not —
      // a browser that refuses localStorage writes is the reachable cause. The
      // host used to swallow that into a console.warn and this toasted an
      // unqualified success over a flavor whose clash config never applied.
      // `toast.error`, not `info`: something the user asked for did not
      // happen, and the longer dwell is what gets the reason read. (#3002)
      if (outcome.unapplied.length > 0) {
        toast.error(flavorSwitchPartial(t, locale, id, outcome.unapplied));
      } else {
        toast.success(t('extensionsFlavors.flavorDialog.toast.switched', { id }));
      }
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.activate'), err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!await confirmDialog({ description: t('extensionsFlavors.flavorDialog.confirmDelete', { id }), destructive: true })) return;
    setBusy(true);
    try {
      await host.flavors.delete(id);
      toast.success(t('extensionsFlavors.flavorDialog.toast.deleted', { id }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.delete'), err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Snapshot the current viewer state into a SPECIFIC flavor (not
   * just the active one). Powers the per-row Capture button, so a
   * user can keep two flavors side-by-side and update each from the
   * same viewer session without switching first.
   *
   * v1 scope: saved lenses. The flavor schema also reserves slots
   * for savedQueries / keybindings / layout / settings — those land
   * as the viewer surfaces them in stores we can read deterministically.
   */
  const handleCaptureInto = async (flavorId: string) => {
    setBusy(true);
    try {
      const target = await host.flavors.list().then((list) => list.find((f) => f.id === flavorId));
      if (!target) {
        toast.error(t('extensionsFlavors.flavorDialog.toast.notFound', { id: flavorId }));
        return;
      }
      const savedLenses = useViewerStore.getState().savedLenses;
      const lenses = savedLenses.map((lens) => ({
        id: lens.id,
        name: lens.name ?? lens.id,
        definition: lens as unknown as Parameters<typeof host.flavors.put>[0]['lenses'][number]['definition'],
      }));
      const next = {
        ...target,
        lenses,
        settings: { ...target.settings, clash: captureClashConfig() } as typeof target.settings,
        // Capture the workspace-sidebar layout (#1208) into the reserved opaque
        // layout slot so it travels with the flavor (order / visible set / mode / width).
        layout: {
          // Preserve any other layout fields an imported / future flavor carries;
          // only the sidebar entry of `state` is being (re)captured here (#1208).
          ...target.layout,
          state: {
            ...target.layout?.state,
            sidebar: useViewerStore.getState().serializeSidebarLayout() as unknown as (typeof target.layout)['state'][string],
          },
        },
        updatedAt: new Date().toISOString(),
      };
      await host.flavors.put(next, 'capture current state');
      toast.success(t('extensionsFlavors.flavorDialog.toast.captured', { count: lenses.length, countDisplay: formatLocaleNumber(locale, lenses.length), name: localizedFlavorName(target, t) }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.capture'), err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Create a brand-new flavor. `snapshot=true` seeds it with the
   * current viewer lenses; otherwise it starts empty. The new flavor
   * is activated so the user can immediately start working in it.
   */
  const handleCreate = async (opts: { name: string; snapshot: boolean }) => {
    setBusy(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Slugify the name for a stable id; fall back to a timestamp.
      const slug = opts.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const id = `local.${slug || 'flavor'}.${stamp}`;
      const now = new Date().toISOString();
      const lenses = opts.snapshot
        ? useViewerStore.getState().savedLenses.map((lens) => ({
            id: lens.id,
            name: lens.name ?? lens.id,
            definition: lens as unknown as Parameters<typeof host.flavors.put>[0]['lenses'][number]['definition'],
          }))
        : [];
      const flavor: Flavor = {
        schemaVersion: 1,
        id,
        name: opts.name,
        description: opts.snapshot
          ? t('extensionsFlavors.flavorDialog.snapshotDescription')
          : t('extensionsFlavors.flavorDialog.emptyDescription'),
        createdAt: now,
        updatedAt: now,
        extensions: [],
        lenses,
        savedQueries: [],
        keybindings: [],
        layout: {
          state: opts.snapshot
            ? { sidebar: useViewerStore.getState().serializeSidebarLayout() }
            : {},
        } as unknown as Flavor['layout'],
        settings: (opts.snapshot ? { clash: captureClashConfig() } : {}) as Flavor['settings'],
      };
      await host.flavors.put(flavor, opts.snapshot ? 'created from current state' : 'created empty');
      await host.flavors.activate(id);
      toast.success(opts.snapshot
        ? t('extensionsFlavors.flavorDialog.toast.createdSnapshot', { name: opts.name, count: lenses.length, countDisplay: formatLocaleNumber(locale, lenses.length) })
        : t('extensionsFlavors.flavorDialog.toast.createdEmpty', { name: opts.name }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.create'), err));
    } finally {
      setBusy(false);
    }
  };

  /** Rename a flavor in place. Keeps the id stable — only `name` changes. */
  const handleRename = async (id: string, name: string) => {
    setBusy(true);
    try {
      const target = await host.flavors.list().then((list) => list.find((f) => f.id === id));
      if (!target) {
        toast.error(t('extensionsFlavors.flavorDialog.toast.notFound', { id }));
        return;
      }
      if (target.name === name) return;
      await host.flavors.put({ ...target, name, updatedAt: new Date().toISOString() }, `renamed to "${name}"`);
      toast.success(t('extensionsFlavors.flavorDialog.toast.renamed', { name }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.rename'), err));
    } finally {
      setBusy(false);
    }
  };

  /** Duplicate a flavor with a fresh id and "(copy)" suffix. */
  const handleDuplicate = async (id: string) => {
    setBusy(true);
    try {
      const target = await host.flavors.list().then((list) => list.find((f) => f.id === id));
      if (!target) {
        toast.error(t('extensionsFlavors.flavorDialog.toast.notFound', { id }));
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const newId = `${target.id}.copy.${stamp}`;
      const now = new Date().toISOString();
      const clone: Flavor = {
        ...target,
        id: newId,
        name: t('extensionsFlavors.flavorDialog.duplicateName', { name: localizedFlavorName(target, t) }),
        createdAt: now,
        updatedAt: now,
      };
      await host.flavors.put(clone, `duplicated from ${target.id}`);
      toast.success(t('extensionsFlavors.flavorDialog.toast.duplicated', { name: clone.name }));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.duplicate'), err));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!await confirmDialog({ description: t('extensionsFlavors.flavorDialog.confirmReset'), destructive: true })) return;
    setBusy(true);
    try {
      await host.flavors.resetToDefaults();
      toast.success(t('extensionsFlavors.flavorDialog.toast.reset'));
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.reset'), err));
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.iflv')) {
      toast.error(t('extensionsFlavors.flavorDialog.toast.expectedFile', { filename: file.name }));
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const unpacked = await host.flavors.preview(bytes);
      setPreview({ bytes, unpacked });
    } catch (err) {
      toast.error(failure(t('extensionsFlavors.flavorDialog.operation.preview'), err));
    }
  };

  const handleConfirmImport = async (strategy: 'replace' | 'save-as-new') => {
    if (!preview) return;
    setBusy(true);
    try {
      const flavor = await host.flavors.importFlavor(preview.unpacked, { strategy });
      toast.success(t('extensionsFlavors.flavorDialog.toast.imported', { name: localizedFlavorName(flavor, t) }));
      setPreview(null);
    } catch (err) {
      if (err && (err as { name?: string }).name === 'ExtensionStorageQuotaError') {
        toast.error(t('extensionsFlavors.flavorDialog.toast.storageFull'));
      } else {
        toast.error(failure(t('extensionsFlavors.flavorDialog.operation.import'), err));
      }
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
            {t('extensionsFlavors.flavorDialog.title')}
            <HelpHint label={t('extensionsFlavors.flavorDialog.title')} side="bottom-start">
              <p>{t('extensionsFlavors.flavorDialog.helpHint.p1')}</p>
              <p>{t('extensionsFlavors.flavorDialog.helpHint.p2')}</p>
              <p>{t('extensionsFlavors.flavorDialog.helpHint.p3')}</p>
              <p>{t('extensionsFlavors.flavorDialog.helpHint.p4')}</p>
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
              liveLensCount={liveLensCount}
              onActivate={(id) => void handleActivate(id)}
              onExport={(id) => void handleExport(id)}
              onDelete={(id) => void handleDelete(id)}
              onImportClick={() => fileInputRef.current?.click()}
              onReset={() => void handleReset()}
              onCaptureInto={(id) => void handleCaptureInto(id)}
              onRename={(id, name) => void handleRename(id, name)}
              onDuplicate={(id) => void handleDuplicate(id)}
              onCreate={(opts) => void handleCreate(opts)}
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
