/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation, formatLocaleNumber } from '@/i18n';
import {
  downloadPercent,
  getSourceSyncProgress,
  subscribeSourceSyncProgress,
  type SourceDownloadState,
} from '@/lib/sources/downloadProgress';
import { cn } from '@/lib/utils';

/** One file's download state in a Sources row: queued, a ring with its
 *  percentage (a spinner while the size is unknown), or failed (#6375). */
export function SourceDownloadStatus({ name, state }: { name: string; state: SourceDownloadState }) {
  const { t, locale } = useTranslation();
  if (state.phase === 'queued') {
    return <span className="shrink-0 text-xs text-muted-foreground">{t('sources.downloadStatus.queued')}</span>;
  }
  if (state.phase === 'preparing') {
    return <Spinner size="sm" label={t('sources.downloadStatus.preparingAria', { name })} />;
  }
  if (state.phase === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-red-600 dark:text-red-400">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        {t('sources.downloadStatus.failed')}
      </span>
    );
  }
  const label = t('sources.downloadStatus.downloadingAria', { name });
  const percent = downloadPercent(state);
  if (percent === undefined) {
    return <Spinner size="sm" label={label} className="shrink-0 text-muted-foreground" />;
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <ProgressRing value={percent} label={label} />
      {formatLocaleNumber(locale, Math.floor(percent) / 100, { style: 'percent', maximumFractionDigits: 0 })}
    </span>
  );
}

/** The live sync-download state of every model, re-rendering on change. */
export function useSourceSyncProgress(): ReadonlyMap<string, SourceDownloadState> {
  return useSyncExternalStore(subscribeSourceSyncProgress, getSourceSyncProgress, getSourceSyncProgress);
}

/** One model's sync-download state; re-renders only when that model's changes. */
export function useModelSyncProgress(modelId: string | undefined): SourceDownloadState | undefined {
  const read = () => (modelId === undefined ? undefined : getSourceSyncProgress().get(modelId));
  return useSyncExternalStore(subscribeSourceSyncProgress, read, read);
}

/**
 * The per-model Sync button's icon: the same ring as a file download while
 * the update downloads with a known size, the spinning sync arrows while
 * it lists, parses, or has no size to measure against, and the idle arrows
 * otherwise.
 */
export function SourceSyncIcon({
  name,
  syncing,
  state,
  className,
}: {
  name: string;
  syncing: boolean;
  state: SourceDownloadState | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const percent = syncing && state ? downloadPercent(state) : undefined;
  if (percent !== undefined) {
    return <ProgressRing value={percent} label={t('sources.downloadStatus.syncingAria', { name })} />;
  }
  return <RefreshCw aria-hidden className={cn('h-3.5 w-3.5', syncing && 'animate-spin', className)} />;
}
