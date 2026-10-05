/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assistantLibrary, useAssistantLibrary } from '@/lib/assistant/library';
import { clashGroupLibrary, useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { bcfDraftLibrary, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { bcfOutboxLibrary, initializeBcfOutbox, useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { clashGroupApplicationLibrary, useClashGroupApplications } from '@/lib/clash/group-applications';
import { useRef, useState } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { downloadFile } from '@/lib/export/download';
import type { ContentCommitReceipt } from '@/lib/storage/content-library';
import type { ContentStatus } from '@/lib/storage/content-library';
import { cleanupContentLegacy, ContentImportFailure, createContentBackup, importContentBackup, parseContentBackup, readBackupDrafts,
  readContentRecovery, retryContentDrafts, retryContentImports } from '@/lib/storage/content-backup';
import { stageContentDrafts } from '@/lib/storage/content-backup-drafts';

const messages = {
  quota: 'contentStorage.quota', unavailable: 'contentStorage.unavailable',
  conflict: 'contentStorage.conflict', invalid: 'contentStorage.invalid',
} as const satisfies Record<string, TranslationKey>;
const visibleLibraries = () => {
  const state = useViewerStore.getState();
  return { validation: state.savedValidationReports, comparison: state.savedComparisons, document: state.documents,
    assistant: useAssistantLibrary.getState().entries, clashGroups: useClashGroupLibrary.getState().entries,
    bcfDrafts: useBcfDraftLibrary.getState().entries, bcfOutbox: useBcfOutbox.getState().entries,
    modelChanges: useModelChangeReceipts.getState().entries, clashGroupApplications: useClashGroupApplications.getState().entries };
};

/** Per-library save status; backup includes all user-content libraries and unsaved drafts. */
export function ContentStorageNotice({ status, retry, restore }: {
  status: ContentStatus; retry: () => Promise<boolean>; restore: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const librariesLoading = useViewerStore(state => [state.documentsStorage, state.validationReportsStorage, state.savedComparisonsStorage]
    .some(library => library.phase === 'loading'));
  const assistantLoading = useAssistantLibrary(s => s.status.phase === 'loading');
  const clashGroupsLoading = useClashGroupLibrary(s => s.status.phase === 'loading');
  const draftsLoading = useBcfDraftLibrary(s => s.status.phase === 'loading');
  const outboxLoading = useBcfOutbox(s => s.status.phase === 'loading');
  const bcfLoading = draftsLoading || outboxLoading;
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
    downloadFile(JSON.stringify(createContentBackup(visibleLibraries(), {
      validation: state.validationReportsStorage, comparison: state.savedComparisonsStorage, document: state.documentsStorage, assistant: useAssistantLibrary.getState().status,
      clashGroups: useClashGroupLibrary.getState().status, bcfDrafts: useBcfDraftLibrary.getState().status,
      bcfOutbox: useBcfOutbox.getState().status,
      modelChanges: useModelChangeReceipts.getState().status,
      clashGroupApplications: useClashGroupApplications.getState().status,
    }, preserved.drafts), null, 2), 'ifc-lite-library-backup.json', 'application/json');
    if (!preserved.complete) toast.info(t('contentStorage.draftReadUnavailable'));
  };
  const importFile = async (file: File) => {
    const parsed = parseContentBackup(await file.text());
    const drafts = parsed.drafts ?? [];
    stageContentDrafts(drafts);
    const state = useViewerStore.getState();
    const initialized = await Promise.all([assistantLibrary.initialize(), clashGroupLibrary.initialize(), bcfDraftLibrary.initialize(), modelChangeLibrary.initialize(), clashGroupApplicationLibrary.initialize(),
      initializeBcfOutbox(), state.initializeValidationReports(), state.initializeSavedComparisons(), state.initializeDocuments()]);
    let count: number, committed: readonly ContentCommitReceipt[] = [];
    try {
      count = await importContentBackup(parsed, visibleLibraries, initialized.every(Boolean), rows => { committed = rows; });
    } catch (error) {
      if (!(error instanceof ContentImportFailure)) throw error;
      // The canonical import plan owns identities, conflicts, deduplication and bindings.
      console.warn('[User content] Import remains in memory', error);
      for (const entry of error.entries.validation) state.stageValidationReport(entry);
      for (const entry of error.entries.comparison) state.stageComparison(entry);
      for (const entry of error.entries.assistant ?? []) assistantLibrary.stage(entry.id, entry);
      for (const entry of error.entries.clashGroups ?? []) clashGroupLibrary.stage(entry.id, entry);
      for (const entry of error.entries.bcfDrafts ?? []) bcfDraftLibrary.stage(entry.id, entry);
      for (const entry of error.entries.modelChanges ?? []) modelChangeLibrary.stage(entry.id, entry);
      for (const entry of error.entries.clashGroupApplications ?? []) clashGroupApplicationLibrary.stage(entry.id, entry);
      // Staged outbox records are visible only; dispatch reads committed rows, and these are already blocked.
      for (const entry of error.entries.bcfOutbox ?? []) bcfOutboxLibrary.stage(entry.id, entry);
      for (const entry of error.entries.document) state.stageDocument(entry);
      toast.error(t('contentStorage.importFailed'));
      if (drafts.length) toast.error(t('contentStorage.draftsUnsaved', { count: drafts.length }));
      return;
    }
    toast.success(t('contentStorage.imported', { count }));
    if (drafts.length) toast.info(t('contentStorage.draftsPreserved', { count: drafts.length }));
    // A committed import is never restaged just because refreshing its UI failed.
    try {
      const refreshed = await Promise.all([assistantLibrary.refresh(committed), clashGroupLibrary.refresh(committed),
        bcfDraftLibrary.refresh(committed), bcfOutboxLibrary.refresh(committed), modelChangeLibrary.refresh(committed), clashGroupApplicationLibrary.refresh(committed), state.refreshValidationReports(committed), state.refreshSavedComparisons(committed), state.refreshDocuments(committed)]);
      if (!refreshed.every(Boolean)) toast.info(t('contentStorage.refreshFailed'));
    }
    catch (error) {
      console.warn('[User content] Import saved but the visible libraries could not refresh', error);
      toast.info(t('contentStorage.refreshFailed'));
    }
  };
  return <div className="shrink-0 px-2 py-1 text-xs" data-content-storage>
    {key && <p role={problem || status.phase === 'unavailable' ? 'alert' : 'status'}>{t(key)}</p>}
    {status.recovered && <p role="alert">{t('contentStorage.recovered')}</p>}
    {(problem || status.phase === 'unavailable') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
      const saved = await retry();
      if (!saved || !await retryContentImports()) toast.error(t('contentStorage.someUnsaved'));
    })}>{t('validationPanel.history.retrySave')}</Button>}
    <details>
      <summary className="cursor-pointer">{t('contentStorage.controls')}</summary>
      <div className="flex flex-wrap gap-1 py-1">
        <Button size="sm" variant="outline" disabled={busy || librariesLoading || assistantLoading || clashGroupsLoading || bcfLoading} onClick={() => void run(backup)}>{t('contentStorage.export')}</Button>
        {problem && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          if (await confirmDialog({ description: t('contentStorage.restoreConfirm'), destructive: true })) await restore();
        })}>{t('contentStorage.restore')}</Button>}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{t('contentStorage.import')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const live = useViewerStore.getState();
          const saved = await Promise.all([assistantLibrary.retry(), clashGroupLibrary.retry(), bcfDraftLibrary.retry(), bcfOutboxLibrary.retry(), modelChangeLibrary.retry(), clashGroupApplicationLibrary.retry(), live.retryDocumentsSave(), live.retryValidationReportsSave(), live.retrySaveComparisons(), retryContentDrafts()]);
          const identitiesSaved = await retryContentImports();
          if (saved.every(Boolean) && identitiesSaved) toast.success(t('contentStorage.saved'));
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
