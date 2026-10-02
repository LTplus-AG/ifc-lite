/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { downloadFile } from '@/lib/export/download';
import type { ContentStatus } from '@/lib/storage/content-library';
import { rebindContentDocument } from '@/lib/storage/content-backup-references';
import { cleanupContentLegacy, createContentBackup, importContentBackup, parseContentBackup, readBackupDrafts,
  readContentRecovery, retryContentDrafts } from '@/lib/storage/content-backup';
import { stageContentDrafts } from '@/lib/storage/content-backup-drafts';

const messages = {
  quota: 'contentStorage.quota', unavailable: 'contentStorage.unavailable',
  conflict: 'contentStorage.conflict', invalid: 'contentStorage.invalid',
} as const satisfies Record<string, TranslationKey>;

/** Per-library save status; backup includes all three libraries and unsaved drafts. */
export function ContentStorageNotice({ status, retry, restore }: {
  status: ContentStatus; retry: () => Promise<boolean>; restore: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const librariesLoading = useViewerStore(state => [state.documentsStorage, state.validationReportsStorage, state.savedComparisonsStorage]
    .some(library => library.phase === 'loading'));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const states = Object.values(status.items);
  const problem = states.find(state => state in messages) as keyof typeof messages | undefined;
  const key = status.phase === 'loading' ? 'contentStorage.loading'
    : problem ? messages[problem] : status.phase === 'unavailable' ? 'contentStorage.unavailable'
      : states.includes('saving') ? 'contentStorage.saving' : states.length ? 'contentStorage.saved' : null;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); }
    catch (error) {
      console.warn('[User content] Action failed', error);
      toast.error(t('contentStorage.failed', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setBusy(false); }
  };
  const backup = async () => {
    const state = useViewerStore.getState();
    const preserved = await readBackupDrafts();
    downloadFile(JSON.stringify(createContentBackup({ validation: state.savedValidationReports,
      comparison: state.savedComparisons, document: state.documents }, {
      validation: state.validationReportsStorage, comparison: state.savedComparisonsStorage, document: state.documentsStorage,
    }, preserved.drafts), null, 2), 'ifc-lite-library-backup.json', 'application/json');
    if (!preserved.complete) toast.info(t('contentStorage.draftReadUnavailable'));
  };
  const importFile = async (file: File) => {
    const parsed = parseContentBackup(await file.text());
    const drafts = parsed.drafts ?? [];
    stageContentDrafts(drafts);
    const state = useViewerStore.getState();
    const initialized = await Promise.all([state.initializeValidationReports(), state.initializeSavedComparisons(), state.initializeDocuments()]);
    try {
      if (!initialized.every(Boolean)) throw new Error('Existing libraries could not be safely read');
      const count = await importContentBackup(parsed);
      await Promise.all([state.refreshValidationReports(), state.refreshSavedComparisons(), state.refreshDocuments()]);
      toast.success(t('contentStorage.imported', { count }));
      if (drafts.length) toast.info(t('contentStorage.draftsPreserved', { count: drafts.length }));
    } catch (error) {
      // Explicit import keeps validated content exportable even when IDB refuses it.
      console.warn('[User content] Import remains in memory', error);
      const { newSavedReport } = await import('@/lib/validation/reports/history');
      const { parseDocumentFile } = await import('@/lib/document/persistence');
      const validation = new Map(parsed.libraries.validation.map(entry => {
        const copy = newSavedReport(entry.snapshot, entry.name, entry.automation); state.stageValidationReport(copy);
        return [entry.id, copy.id] as const;
      }));
      const comparison = new Map(parsed.libraries.comparison.map(entry => {
        const copy = { ...entry, id: crypto.randomUUID() }; state.stageComparison(copy);
        return [entry.id, copy.id] as const;
      }));
      for (const entry of parsed.libraries.document) state.stageDocument(parseDocumentFile(JSON.stringify(rebindContentDocument(entry, comparison, validation))));
      toast.error(t('contentStorage.importFailed'));
      if (drafts.length) toast.error(t('contentStorage.draftsUnsaved', { count: drafts.length }));
    }
  };
  return <div className="shrink-0 px-2 py-1 text-xs" data-content-storage>
    {key && <p role={problem || status.phase === 'unavailable' ? 'alert' : 'status'}>{t(key)}</p>}
    {status.recovered && <p role="alert">{t('contentStorage.recovered')}</p>}
    {(problem || status.phase === 'unavailable') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await retry(); })}>{t('validationPanel.history.retrySave')}</Button>}
    <details>
      <summary className="cursor-pointer">{t('contentStorage.controls')}</summary>
      <div className="flex flex-wrap gap-1 py-1">
        <Button size="sm" variant="outline" disabled={busy || librariesLoading} onClick={() => void run(backup)}>{t('contentStorage.export')}</Button>
        {problem && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          if (await confirmDialog({ description: t('contentStorage.restoreConfirm'), destructive: true })) await restore();
        })}>{t('contentStorage.restore')}</Button>}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{t('contentStorage.import')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const live = useViewerStore.getState();
          const saved = await Promise.all([live.retryDocumentsSave(), live.retryValidationReportsSave(), live.retrySaveComparisons(), retryContentDrafts()]);
          if (saved.every(Boolean)) toast.success(t('contentStorage.saved'));
          else toast.error(t('contentStorage.someUnsaved'));
        })}>{t('contentStorage.retryAll')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          downloadFile(JSON.stringify(await readContentRecovery(), null, 2), 'ifc-lite-preserved-originals.json', 'application/json');
        })}>{t('contentStorage.recovery')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          if (await confirmDialog({ description: t('contentStorage.cleanupConfirm') })) {
            await cleanupContentLegacy(); toast.success(t('contentStorage.cleaned'));
          }
        })}>{t('contentStorage.cleanup')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const estimate = await navigator.storage?.estimate?.();
          const live = useViewerStore.getState();
          const bytes = new Blob([JSON.stringify([live.documents, live.savedComparisons, live.savedValidationReports])]).size;
          const mib = (value: number | undefined) => value === undefined ? t('contentStorage.unknown') : (value / 1024 / 1024).toFixed(1);
          toast.info(t('contentStorage.estimate', { library: mib(bytes), usage: mib(estimate?.usage), quota: mib(estimate?.quota) }));
        })}>{t('contentStorage.checkUsage')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const protectedStorage = await navigator.storage?.persist?.();
          toast.info(t(protectedStorage ? 'contentStorage.protected' : 'contentStorage.notProtected'));
        })}>{t('contentStorage.protect')}</Button>
      </div>
    </details>
    <input ref={input} type="file" accept=".json" className="hidden" aria-label={t('contentStorage.import')}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => importFile(file)); }} />
  </div>;
}
