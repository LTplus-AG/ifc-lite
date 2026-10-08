/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF drafts & publication (#6896): review draft batches drafted from clash
 * groups or findings, edit and reconcile them, exchange them as .bcfzip, and
 * publish them through the durable outbox. Every outbox entry that needs a
 * decision — from any batch, an imported backup or a Flow run — is listed.
 */

import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { sanitizeFilename } from '@/lib/export/download';
import { publishBcfArchive } from '@/lib/bcf-drafts/archive-activity';
import { exportDraftArchive, importDraftArchive } from '@/lib/bcf-drafts/draft-archive';
import { mergeDraftTopics, type DraftEditResult } from '@/lib/bcf-drafts/draft-edit';
import { adoptImportedBatches, bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { sameTarget } from '@/lib/bcf-publication/outbox-dispatch';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { BCFDraftReconcile } from './BCFDraftReconcile';
import { BCFDraftTopicEditor } from './BCFDraftTopicEditor';
import { BCFOutboxEntry } from './BCFOutboxEntry';
import { BCFPublicationPanel, useBcfConnection } from './BCFPublicationPanel';

const REFUSALS = { 'unknown-topic': 'bcfDrafts.edit.unknownTopic', 'empty-split': 'bcfDrafts.edit.emptySplit',
  'merge-needs-two': 'bcfDrafts.edit.mergeNeedsTwo', invalid: 'bcfDrafts.edit.invalid' } as const;

/** Outbox entries elsewhere (other batches, imports, Flow) that wait for a coordinator decision. */
function OutboxAttention({ excludeId }: { excludeId: string | null }) {
  const { t } = useTranslation();
  const records = useBcfOutbox(state => state.entries);
  const { config, connect } = useBcfConnection();
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof connect>>>(null);
  useEffect(() => { void connect().then(setConnection).catch(error => console.warn('[BCF publication] Not connected', error)); }, [config, connect]);
  const open = records.filter(record => record.id !== excludeId && record.entries.some(entry => entry.state === 'uncertain' || entry.state === 'blocked'));
  if (!open.length) return null;
  return (
    <section className="rounded-md border border-amber-500/40 p-2 text-xs" aria-label={t('bcfDrafts.attention.region')}>
      <p className="font-medium">{t('bcfDrafts.attention.title')}</p>
      {open.map(record => (
        <div key={record.id} className="mt-1">
          <p>{t(record.origin === 'flow' ? 'bcfDrafts.attention.flow' : 'bcfDrafts.attention.batch',
            { name: record.batchName ?? '', server: record.target.serverUrl, project: record.target.projectName ?? record.target.projectId })}</p>
          <ul>{record.entries.filter(entry => entry.state === 'uncertain' || entry.state === 'blocked').map(entry => (
            <BCFOutboxEntry key={entry.id} record={record} entry={entry} label={String(entry.payload.title ?? entry.payload.comment ?? entry.subject ?? entry.id)}
              connection={connection && sameTarget(record, connection) ? connection : null} />
          ))}</ul>
        </div>
      ))}
    </section>
  );
}

export function BCFDraftsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const library = useBcfDraftLibrary();
  const author = useViewerStore(state => state.bcfAuthor);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mergeSet, setMergeSet] = useState<Set<string>>(new Set());
  const [users, setUsers] = useState<string[]>([]);
  useEffect(() => { if (open) void bcfDraftLibrary.initialize(); }, [open]);
  const batch = library.entries.find(entry => entry.id === library.activeId) ?? null;
  const [recordId, setRecordId] = useState<string | null>(null);
  const record = useBcfOutbox(state => state.entries.find(item => item.id === recordId));

  const save = (next: DraftBatch) => { void saveDraftBatch(next); setMergeSet(new Set()); };
  const onEdit = (result: DraftEditResult | Promise<DraftEditResult>) => {
    void Promise.resolve(result).then(outcome => {
      if (outcome.ok) save(outcome.batch);
      else toast.error(t(REFUSALS[outcome.reason]));
    }).catch(error => { console.error('[BCF drafts] Edit failed', error); toast.error(t('bcfDrafts.edit.invalid')); });
  };
  const exportArchive = async () => {
    if (!batch) return;
    try {
      await publishBcfArchive(batch.name, `${sanitizeFilename(batch.name)}.bcfzip`, () => exportDraftArchive(batch, author));
    } catch (error) {
      console.error('[BCF drafts] Archive export failed', error);
      toast.error(error instanceof Error ? error.message : t('bcfDrafts.archive.failed'));
    }
  };
  const importArchive = async (file: File) => {
    try {
      const imported = await importDraftArchive(await file.arrayBuffer());
      const adopted = await adoptImportedBatches(imported.batches);
      if (adopted[0]) useBcfDraftLibrary.setState({ activeId: adopted[0].id });
      toast.success(t('bcfDrafts.archive.imported', { count: adopted.length }));
      if (imported.unmapped || imported.damaged) toast.info(t('bcfDrafts.archive.unmapped', { count: imported.unmapped + imported.damaged }));
    } catch (error) {
      console.error('[BCF drafts] Archive import failed', error);
      toast.error(error instanceof Error ? error.message : t('bcfDrafts.archive.failed'));
    }
  };
  const publicationOf = (guid: string) => {
    const create = record?.entries.find(entry => entry.operation === 'createTopic' && entry.topicGuid === guid);
    return create ? t(`bcfDrafts.topic.publication.${create.state}`, { guid: create.receipt?.remoteGuid ?? '' }) : undefined;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>{t('bcfDrafts.dialog.title')}</DialogTitle></DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              {t('bcfDrafts.dialog.batch')}
              <select className="h-7 min-w-0 flex-1 rounded border border-border bg-background" value={batch?.id ?? ''}
                disabled={!library.entries.length} onChange={event => { useBcfDraftLibrary.setState({ activeId: event.target.value }); setMergeSet(new Set()); }}>
                {!library.entries.length && <option value="">{t('bcfDrafts.dialog.noBatches')}</option>}
                {library.entries.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.topics.length}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => fileInput.current?.click()}>{t('bcfDrafts.archive.import')}</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!batch} onClick={() => void exportArchive()}>{t('bcfDrafts.archive.export')}</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!batch || mergeSet.size < 2}
              onClick={() => batch && onEdit(mergeDraftTopics(batch, batch.topics.filter(topic => mergeSet.has(topic.guid)).map(topic => topic.guid)))}>
              {t('bcfDrafts.dialog.merge', { count: mergeSet.size })}
            </Button>
            <input ref={fileInput} type="file" accept=".bcf,.bcfzip" className="hidden" aria-label={t('bcfDrafts.archive.import')}
              onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importArchive(file); }} />
          </div>
          <ContentStorageNotice status={library.status} retry={bcfDraftLibrary.retry} restore={bcfDraftLibrary.restore} />
          {!batch && <p className="text-xs text-muted-foreground">{t('bcfDrafts.dialog.empty')}</p>}
          {batch && batch.source.kind === 'clash' && <BCFDraftReconcile batch={batch} onChange={save} />}
          {batch?.topics.map(topic => (
            <BCFDraftTopicEditor key={topic.guid} batch={batch} topic={topic} users={users} publication={publicationOf(topic.guid)}
              mergeSelected={mergeSet.has(topic.guid)} onEdit={onEdit}
              onToggleMerge={guid => setMergeSet(current => { const next = new Set(current); if (!next.delete(guid)) next.add(guid); return next; })} />
          ))}
          {batch && <BCFPublicationPanel batch={batch} onUsers={setUsers} onRecordId={setRecordId} />}
          <OutboxAttention excludeId={batch ? recordId : null} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
