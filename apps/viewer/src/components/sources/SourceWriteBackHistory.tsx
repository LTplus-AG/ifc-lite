/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { usePagedList } from './usePagedList';

export function SourceWriteBackHistory({ provider, ctx, projectId, file, created }: {
  provider: FileSourceProvider; ctx: PluginContext; projectId: string; file: SourceFile; created: SourceRevision;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const fetchPage = useCallback((cursor: string | undefined, signal: AbortSignal) => provider.listRevisions
    ? provider.listRevisions(ctx, { projectId, containerId: file.containerId, fileId: file.id }, { cursor, signal, limit: 50 })
    : Promise.resolve({ items: [] }), [provider, ctx, projectId, file.containerId, file.id]);
  const history = usePagedList<SourceRevision>(fetchPage, setError), start = history.start;
  useEffect(() => { start(); }, [start]);
  const revisions = [created, ...history.items.filter(revision => revision.id !== created.id)];
  return <section aria-label={t('sources.writeBack.history')} className="space-y-2">
    <p className="break-words">{file.name}</p>
    <ul>{revisions.map(revision => <li key={revision.id}>{revision.label} · {revision.createdAt}</li>)}</ul>
    {error && <p role="alert">{t('sources.writeBack.historyError', { reason: error })}</p>}
    {history.loading && <output>{t('sources.writeBack.loading')}</output>}
    {history.hasMore && <Button type="button" variant="outline" disabled={history.loadingMore} onClick={history.loadMore}>{t('sources.writeBack.moreHistory')}</Button>}
  </section>;
}
