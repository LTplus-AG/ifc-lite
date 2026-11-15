/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceContainer } from '@ifc-lite/plugin-api';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { usePagedList } from './usePagedList';

/** Browse actual provider containers, with explicit pagination and no guessed root ids. */
export function SourceWriteBackFolder({ provider, ctx, projectId, onChoose }: {
  provider: FileSourceProvider; ctx: PluginContext; projectId: string;
  onChoose: (container: SourceContainer) => void;
}) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<SourceContainer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parent = trail.at(-1);
  const fetchPage = useCallback((cursor: string | undefined, signal: AbortSignal) =>
    provider.listContainers(ctx, projectId, parent?.id, { cursor, signal, limit: 50 }), [provider, ctx, projectId, parent?.id]);
  const folders = usePagedList(fetchPage, setError);
  const start = folders.start;
  useEffect(() => { setError(null); start(); }, [start]);
  const visible = provider.manifest.capabilities.containerListing === 'flat-subtree'
    ? folders.items.filter(folder => folder.parentId === parent?.id) : folders.items;
  return <section className="space-y-2 rounded border p-2" aria-label={t('sources.writeBack.folder')}>
    <p>{trail.map(folder => folder.name).join(' / ') || t('sources.writeBack.projectFolders')}</p>
    {parent && <div className="flex gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => setTrail(trail.slice(0, -1))}>{t('sources.writeBack.up')}</Button>
      <Button type="button" size="sm" onClick={() => onChoose(parent)}>{t('sources.writeBack.useFolder')}</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {folders.loading && <output>{t('sources.writeBack.loading')}</output>}
    <ul className="max-h-36 overflow-auto">{visible.filter(folder => !trail.some(ancestor => ancestor.id === folder.id)).map(folder =>
      <li key={folder.id}><Button type="button" size="sm" variant="ghost" onClick={() => setTrail([...trail, folder])}>{folder.name}</Button></li>)}</ul>
    {folders.hasMore && <Button type="button" size="sm" variant="outline" disabled={folders.loadingMore} onClick={folders.loadMore}>{t('sources.writeBack.moreFolders')}</Button>}
  </section>;
}
