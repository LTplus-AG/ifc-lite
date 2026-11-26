/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceContainer } from '@ifc-lite/plugin-api';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { usePagedList } from './usePagedList';
import { fetchContainerPage } from './sourceCatalogPaging';

/** Browse actual provider containers, with explicit pagination and no guessed root ids. */
export function SourceWriteBackFolder({ provider, ctx, projectId, onChoose }: {
  provider: FileSourceProvider; ctx: PluginContext; projectId: string;
  onChoose: (container: SourceContainer) => void;
}) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<SourceContainer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parent = trail.at(-1);
  // A flat-subtree listing returns every descendant of the top container, so one
  // fetch serves every level below it; nest client-side by parentId.
  const flat = provider.manifest.capabilities.containerListing === 'flat-subtree';
  const listed = flat ? trail[0]?.id : parent?.id;
  const fetchPage = useCallback((cursor: string | undefined, signal: AbortSignal) =>
    fetchContainerPage(provider, ctx, projectId, listed, cursor, signal), [provider, ctx, projectId, listed]);
  const folders = usePagedList(fetchPage, setError);
  const start = folders.start;
  useEffect(() => { setError(null); start(); }, [start]);
  const visible = flat ? folders.items.filter(folder => folder.parentId === parent?.id) : folders.items;
  return <section className="space-y-2 rounded border p-2" aria-label={t('sources.writeBack.folder')}>
    <p>{trail.map(folder => folder.name).join(' / ') || t('sources.writeBack.projectFolders')}</p>
    {parent && <div className="flex gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => setTrail(trail.slice(0, -1))}>{t('sources.writeBack.up')}</Button>
      <Button type="button" size="sm" onClick={() => onChoose(parent)}>{t('sources.writeBack.useFolder')}</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {folders.loading && <output>{t('sources.writeBack.loading')}</output>}
    {!folders.loading && <ul className="max-h-36 overflow-auto">{visible.filter(folder => !trail.some(ancestor => ancestor.id === folder.id)).map(folder =>
      <li key={folder.id}><Button type="button" size="sm" variant="ghost" onClick={() => setTrail([...trail, folder])}>{folder.name}</Button></li>)}</ul>}
    {folders.hasMore && <Button type="button" size="sm" variant="outline" disabled={folders.loadingMore} onClick={folders.loadMore}>{t('sources.writeBack.moreFolders')}</Button>}
  </section>;
}
