/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileSourceProvider, SourceFile } from '@ifc-lite/plugin-api';
import { dispatchSourceDownload, type SourceHost } from '@/services/sources/source-host';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { sanitizeFilename } from '@/lib/export/download';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import type { SourceDownloadState } from '@/lib/sources/downloadProgress';

export interface SourceDownloadSelection {
  readonly projectId: string;
  readonly files: readonly SourceFile[];
}

interface UseSourceDownloadBatchOptions {
  /** Provider being browsed, and its manifest name; absent when none is. */
  provider: FileSourceProvider | undefined;
  providerId: string | null;
  sourceHost: SourceHost;
  /** Runs once a batch has downloaded every file (typically: close the browser). */
  onBatchSucceeded: () => void;
}

const NO_DOWNLOADS: ReadonlyMap<string, SourceDownloadState> = new Map();

/**
 * The Sources panel's Load batch (#6375).
 *
 * Downloads run one file at a time and each finished file is dispatched (and
 * its buffer reference dropped) before the next download starts, so whole
 * batches of large IFCs are never held in memory simultaneously. The
 * viewport listener serializes the resulting loads.
 *
 * Every file in the batch has a state its row draws: queued, then
 * downloading (a ring fed by the provider's `onProgress`), then no entry
 * once dispatched, because its parse is the viewport loading card's to
 * report. A file that fails stays `failed`. The caller keeps the browser
 * open until the batch ends, and `onBatchSucceeded` runs only when nothing
 * failed, so a failed row is still on screen after the batch.
 *
 * The batch is aborted when the caller unmounts, or when a new batch starts.
 */
export function useSourceDownloadBatch({
  provider,
  providerId,
  sourceHost,
  onBatchSucceeded,
}: UseSourceDownloadBatchOptions) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const [downloadStates, setDownloadStates] = useState<ReadonlyMap<string, SourceDownloadState>>(NO_DOWNLOADS);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleDownload = useCallback(
    async ({ projectId, files }: SourceDownloadSelection) => {
      if (!provider || !providerId) return;
      const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      const providerTitle = provider.manifest.title;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const setFileState = (fileId: string, state: SourceDownloadState | undefined) => {
        if (controller.signal.aborted) return;
        setDownloadStates((previous) => {
          const next = new Map(previous);
          if (state) next.set(fileId, state);
          else next.delete(fileId);
          return next;
        });
      };

      setDownloadStates(new Map(files.map((f) => [f.id, { phase: 'queued' }] as const)));
      setDownloading(true);
      try {
        let failed = 0;
        for (const f of files) {
          if (controller.signal.aborted) break;
          // Started, size not yet known: a spinner until the provider's first
          // `onProgress` (a provider that never reports keeps the spinner).
          setFileState(f.id, { phase: 'downloading', received: 0 });
          try {
            const buffer = await provider.download(
              ctx,
              { projectId, containerId: f.containerId, fileId: f.id },
              {
                signal: controller.signal,
                onProgress: (received, total) => setFileState(f.id, { phase: 'downloading', received, total }),
              },
            );
            dispatchSourceDownload([
              {
                // `f.name` is provider-supplied and reaches `new File(...)` and
                // `addModel`, so it is untrusted input to a filename position.
                // Sanitize at the boundary rather than trusting every provider
                // to have done it — the same contract the export paths use.
                name: sanitizeFilename(f.name, { fallback: 'model.ifc' }),
                buffer,
                sourceFile: f,
                tag: sourceHost.createSourceTag(providerId, projectId, f.containerId, f.id, f.currentRevisionId),
              },
            ]);
            setFileState(f.id, undefined);
          } catch (err) {
            if (controller.signal.aborted) break;
            failed += 1;
            setFileState(f.id, { phase: 'failed' });
            toast.error(
              err instanceof Error
                ? t('sources.sourcesPanel.downloadFailedWithMessage', { name: f.name, message: err.message })
                : t('sources.sourcesPanel.downloadFailedGeneric', { name: f.name, title: providerTitle }),
            );
          }
        }
        if (!controller.signal.aborted && failed === 0) onBatchSucceeded();
      } finally {
        setDownloading(false);
      }
    },
    [onBatchSucceeded, provider, providerId, sourceHost, t],
  );

  /** Forgets finished rows' states (a failed row's), e.g. when the browser closes. */
  const clearDownloadStates = useCallback(() => setDownloadStates(NO_DOWNLOADS), []);

  return { downloading, downloadStates, handleDownload, clearDownloadStates };
}
