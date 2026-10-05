/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';
import { usePagedList } from './usePagedList';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

export function SourceResourceDetails({ provider, ctx, projectId, file, selectedFile, busy, onSelect }: {
  provider: FileSourceProvider; ctx: PluginContext; projectId: string; file: SourceFile;
  selectedFile?: SourceFile; busy: boolean; onSelect: (file: SourceFile) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const fetchPage = useCallback((cursor: string | undefined, signal: AbortSignal) => {
    if (!provider.listRevisions) return Promise.resolve({ items: [] });
    return provider.listRevisions(ctx, { projectId, containerId: file.containerId, fileId: file.id }, { cursor, signal, limit: 50 });
  }, [provider, ctx, projectId, file.containerId, file.id]);
  const versions = usePagedList<SourceRevision>(fetchPage, setError);
  const selected = selectedFile?.currentRevisionId ?? file.currentRevisionId;
  return (
    <details className="px-3 pb-2 text-xs" onToggle={(event) => {
      if (event.currentTarget.open) { setError(null); versions.start(); }
      else versions.reset();
    }}>
      <summary className="cursor-pointer text-muted-foreground">{t('sources.resourceDetails.title')}</summary>
      <div className="mt-2 space-y-2 rounded border p-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t('sources.workspace.fileName')}</dt><dd className="break-words">{file.name}</dd>
          {file.sizeBytes != null && <><dt className="text-muted-foreground">{t('sources.workspace.fileSize')}</dt><dd>{t('sources.workspace.kilobytes', { size: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(file.sizeBytes / 1024) })}</dd></>}
          {file.modifiedAt && <><dt className="text-muted-foreground">{t('sources.workspace.modified')}</dt><dd>{file.modifiedAt}</dd></>}
          {file.modifiedBy && <><dt className="text-muted-foreground">{t('sources.workspace.modifiedBy')}</dt><dd>{file.modifiedBy}</dd></>}
        </dl>
        <p>{file.kind === 'proposal' ? t('sources.resourceDetails.proposal') : file.kind === 'exchange'
          ? t('sources.resourceDetails.exchange') : t('sources.resourceDetails.file')}</p>
        {file.kind === 'exchange' && <p>{t('sources.resourceDetails.exchangeVersions')}</p>}
        {file.kind === 'proposal' && <p>{t('sources.resourceDetails.proposalFidelity')}</p>}
        {error && <p role="alert" className="text-red-600">{error}</p>}
        {!provider.listRevisions && <p>{t('sources.workspace.noVersions')}</p>}
        {versions.loading && <output>{t('sources.resourceDetails.loading')}</output>}
        <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label={t('sources.resourceDetails.versions')}>
          {versions.items.map((revision) => {
            const historicalExchange = file.kind === 'exchange' && revision.id !== file.currentRevisionId;
            return <li key={revision.id}>
              <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-accent disabled:opacity-50"
                disabled={busy || Boolean(file.unavailableReason) || historicalExchange} aria-pressed={selected === revision.id}
                onClick={() => onSelect({ ...file, currentRevisionId: revision.id,
                  meta: { ...file.meta, selectedRevisionId: revision.id, selectedRevisionLabel: revision.label } })}>
                {revision.id === file.currentRevisionId ? t('sources.resourceDetails.current', { version: revision.label }) : revision.label}
                {revision.createdAt && ` · ${new Date(revision.createdAt).toLocaleDateString()}`}
                {revision.createdBy && ` · ${revision.createdBy}`}
                {selected === revision.id && ` · ${t('sources.resourceDetails.selected')}`}
              </button>
            </li>;
          })}
        </ul>
        {versions.hasMore && <Button variant="outline" size="sm" disabled={versions.loadingMore} onClick={versions.loadMore}>{t('sources.resourceDetails.more')}</Button>}
        {error && <Button variant="outline" size="sm" onClick={() => { setError(null); versions.start(); }}>{t('sources.resourceDetails.retry')}</Button>}
      </div>
    </details>
  );
}
