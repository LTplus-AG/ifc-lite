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
import { beginActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';

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
      if (!provider || !providerId || files.length === 0) return;
      const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      const providerTitle = provider.manifest.title;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const job = beginActivity({ kind: 'load', title: 'activityTray.job.sourceDownload', subject: providerTitle,
        cancel: () => {
          if (abortRef.current !== controller) return;
          controller.abort();
          setDownloading(false);
          setDownloadStates(NO_DOWNLOADS);
        } });
      let dispatched = 0;
      let failed = 0;
      updateActivity(job, { progress: { done: 0, total: files.length } });

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
        for (const f of files) {
          if (controller.signal.aborted) break;
          // Started, size not yet known: a spinner until the provider's first
          // `onProgress` (a provider that never reports keeps the spinner).
          setFileState(f.id, { phase: 'downloading', received: 0 });
          updateActivity(job, { phase: f.name, progress: { done: dispatched + failed, total: files.length } });
          try {
            const buffer = await provider.download(
              ctx,
              { projectId, containerId: f.containerId, fileId: f.id, revisionId: f.currentRevisionId },
              {
                signal: controller.signal,
                onPhase: (phase) => phase === 'preparing' && setFileState(f.id, { phase: 'preparing' }),
                onProgress: (received, total) => setFileState(f.id, { phase: 'downloading', received, total }),
              },
            );
            controller.signal.throwIfAborted();
            dispatchSourceDownload([
              {
                // `f.name` is provider-supplied and reaches `new File(...)` and
                // `addModel`, so it is untrusted input to a filename position.
                // Sanitize at the boundary rather than trusting every provider
                // to have done it — the same contract the export paths use.
                name: sanitizeFilename(f.artifactName ?? f.name, { fallback: 'model.ifc' }),
                buffer,
                sourceFile: f,
                tag: sourceHost.createSourceTag(providerId, projectId, f.containerId, f.id, f.currentRevisionId),
              },
            ]);
            dispatched += 1;
            setFileState(f.id, undefined);
            updateActivity(job, { progress: { done: dispatched + failed, total: files.length } });
          } catch (err) {
            if (controller.signal.aborted) break;
            failed += 1;
            updateActivity(job, { progress: { done: dispatched + failed, total: files.length } });
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
        const stopped = controller.signal.aborted;
        // Cancellation after the final dispatch stopped no download work (#7134).
        const incomplete = dispatched !== files.length;
        finishActivity(job, incomplete ? (dispatched > 0 ? 'partial' : stopped ? 'cancelled' : 'failed') : 'completed',
          incomplete && dispatched > 0
            ? { detail: t(stopped ? 'activityTray.sourceDownload.partialCancelled' : 'activityTray.sourceDownload.partialFailed', { count: dispatched }) }
            : failed > 0 ? { detail: t('activityTray.sourceDownload.failed', { count: failed }) } : {});
        if (abortRef.current === controller) {
          abortRef.current = null;
          setDownloading(false);
        }
      }
    },
    [onBatchSucceeded, provider, providerId, sourceHost, t],
  );

  /**
   * Forgets finished rows (failed ones) when the browser closes. Rows of a
   * batch still running stay: Back does not cancel the batch, so a browser
   * reopened mid-batch shows it truthfully instead of half-cleared.
   */
  const clearFinishedDownloadStates = useCallback(() => {
    setDownloadStates((previous) => {
      const next = new Map([...previous].filter(([, state]) => state.phase !== 'failed'));
      return next.size === previous.size ? previous : next;
    });
  }, []);

  const cancelDownload = useCallback(() => {
    abortRef.current?.abort();
    setDownloading(false);
    setDownloadStates(NO_DOWNLOADS);
  }, []);
  return { downloading, downloadStates, handleDownload, cancelDownload, clearFinishedDownloadStates };
}
