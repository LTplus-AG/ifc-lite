/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceFile } from '@ifc-lite/plugin-api';
import { Search, FileBox } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { usePagedList } from './usePagedList';
import { LoadMoreRow } from './SourceEntityList';
import { createSourceWideSearch, type SourceSearchMatch } from './sourceWideSearchModel';
import { SourceLoadedBadge } from './SourceLoadedBadge';
import { SourceResourceDetails } from './SourceResourceDetails';
import { SourceDownloadStatus } from './SourceDownloadStatus';
import type { SourceDownloadState } from '@/lib/sources/downloadProgress';

export function SourceWideSearch({ provider, ctx, onDownload, busy, downloadStates, downloadProjectId }: {
  provider: FileSourceProvider; ctx: PluginContext;
  onDownload: (selection: { projectId: string; files: readonly SourceFile[] }) => void;
  busy: boolean; downloadStates: ReadonlyMap<string, SourceDownloadState>;
  downloadProjectId: string | null;
}) {
  const { t } = useTranslation();
  const [revisions, setRevisions] = useState<ReadonlyMap<string, SourceFile>>(() => new Map());
  const [opening, setOpening] = useState<{ projectId: string; fileId: string } | null>(null);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fetcher, setFetcher] = useState(() => createSourceWideSearch(provider, ctx, ''));
  // Stable across input edits; submitting creates a new isolated cursor session.
  const paged = usePagedList<SourceSearchMatch>(fetcher, setError);
  const [startPending, setStartPending] = useState(false);
  const { start } = paged;
  const submit = useCallback(() => {
    if (!query.trim()) return;
    setError(null);
    setOpening(null);
    setRevisions(new Map());
    setSubmitted(query.trim());
    setFetcher(() => createSourceWideSearch(provider, ctx, query.trim()));
    setStartPending(true);
  }, [provider, ctx, query]);
  // Run after the fetcher is committed, rather than searching the previous query.
  useEffect(() => {
    if (startPending) { start(); setStartPending(false); }
  }, [startPending, start]);
  const results = useMemo(() => [...new Map(paged.items.map((match) => [JSON.stringify([match.project.id, match.file.id]), match])).values()], [paged.items]);
  return <section className="border-b p-3" aria-label={t('sources.workspace.searchSection')}>
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input className="h-8 pl-8" aria-label={t('sources.workspace.searchAria', { title: provider.manifest.title })}
          placeholder={t('sources.workspace.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={!query.trim()}>{t('sources.workspace.search')}</Button>
    </form>
    <p className="mt-1 text-xs text-muted-foreground">{t(provider.manifest.capabilities.search && provider.searchFiles ? 'sources.workspace.searchScope' : 'sources.workspace.searchListed', { title: provider.manifest.title })}</p>
    {provider.manifest.capabilities.projectsAreDiscoverableOnly && <p className="mt-1 text-xs text-muted-foreground">{t('sources.workspace.discoverable')}</p>}
    {submitted && <div className="mt-2">
      <Button size="sm" variant="ghost" onClick={() => { setSubmitted(''); setQuery(''); setError(null); setOpening(null); setRevisions(new Map()); setStartPending(false); paged.reset(); }}>{t('sources.workspace.clearResults')}</Button>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {(paged.loading || startPending) && <output className="flex items-center gap-2 text-xs"><Spinner size="sm" />{t('sources.workspace.searching')}</output>}
      {!paged.loading && !startPending && results.length === 0 && !error && <output className="block py-2 text-xs text-muted-foreground">{t(paged.hasMore ? 'sources.workspace.searchContinue' : 'sources.sourceFolderStep.noSearchResults')}</output>}
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {results.map(({ file, project }) => <li key={JSON.stringify([project.id, file.id])} className="rounded border p-2">
          <div className="flex items-start gap-2"><FileBox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{file.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{project.name}</span>
              {file.modifiedAt && <span className="block text-xs text-muted-foreground">{file.modifiedAt}</span>}
              <SourceLoadedBadge providerId={provider.manifest.name} projectId={project.id} fileId={file.id}
                revisionId={(revisions.get(JSON.stringify([project.id, file.id])) ?? file).currentRevisionId} />
              {file.unavailableReason && <span className="block text-xs text-muted-foreground">{file.unavailableReason}</span>}
            </span>
          </div>
          <Button size="sm" variant="outline" className="mt-2 w-full" disabled={busy || Boolean(file.unavailableReason)}
            onClick={() => { setOpening({ projectId: project.id, fileId: file.id }); onDownload({ projectId: project.id, files: [revisions.get(JSON.stringify([project.id, file.id])) ?? file] }); }}>{t('sources.workspace.openFile', { name: file.name })}</Button>
          <SourceResourceDetails provider={provider} ctx={ctx} projectId={project.id} file={file}
            selectedFile={revisions.get(JSON.stringify([project.id, file.id]))} busy={busy}
            onSelect={(revision) => setRevisions((previous) => new Map(previous).set(JSON.stringify([project.id, file.id]), revision))} />
          {downloadProjectId === project.id && opening?.projectId === project.id && opening.fileId === file.id && downloadStates.get(file.id) && <SourceDownloadStatus name={file.name} state={downloadStates.get(file.id)!} />}
        </li>)}
      </ul>
      <LoadMoreRow hasMore={paged.hasMore} loading={paged.loadingMore} onLoadMore={() => { setError(null); paged.loadMore(); }} label={t('sources.workspace.moreSearch')} />
      {error && <Button size="sm" variant="outline" onClick={submit}>{t('sources.resourceDetails.retry')}</Button>}
    </div>}
  </section>;
}
