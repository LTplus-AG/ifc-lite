/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceFile } from '@ifc-lite/plugin-api';
import type { DownloadedSourceFileStatus } from '@/lib/sources/persistence';
import type { SourceDownloadState } from '@/lib/sources/downloadProgress';
import { FileBox, Star } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { SourceResourceDetails } from './SourceResourceDetails';
import type { ComponentProps } from 'react';
import { SourceDownloadStatus, SourceSyncIcon } from './SourceDownloadStatus';

interface SourceFileRowProps {
  file: SourceFile;
  details?: Omit<ComponentProps<typeof SourceResourceDetails>, 'file'>;
  selected: boolean;
  onToggle: () => void;
  loadedModelNames: readonly string[];
  syncingFile: boolean;
  /** Download progress of the running Sync, once it has reached the download. */
  syncState?: SourceDownloadState;
  onSyncLoadedFile: () => void;
  /** This file's place in the running Load batch; absent when it is not in one. */
  downloadState?: SourceDownloadState;
  downloadedStatus: DownloadedSourceFileStatus;
  favourited: boolean;
  onToggleFavourite: () => void;
}

export function SourceFileRow({
  file,
  details,
  selected,
  onToggle,
  loadedModelNames,
  syncingFile,
  syncState,
  onSyncLoadedFile,
  downloadState,
  downloadedStatus,
  favourited,
  onToggleFavourite,
}: SourceFileRowProps) {
  const { t } = useTranslation();
  const isLoadedInHierarchy = loadedModelNames.length > 0;
  const isUpdateAvailable = downloadedStatus === 'update-available';

  return (
    <li>
      <div
        className={`flex w-full items-start gap-2 px-3 py-2 text-sm hover:bg-accent ${
          isUpdateAvailable ? 'text-orange-600 dark:text-orange-400' : ''
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={selected}
          disabled={Boolean(file.unavailableReason)}
          onChange={onToggle}
          aria-label={
            selected
              ? t('sources.sourceFileRow.deselectAria', { name: file.name })
              : t('sources.sourceFileRow.selectAria', { name: file.name })
          }
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={onToggle}
          disabled={Boolean(file.unavailableReason)}
        >
          <FileBox
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              isUpdateAvailable ? 'text-orange-500 dark:text-orange-400' : 'text-muted-foreground'
            }`}
          />
          <span className="min-w-0 flex-1">
            <span className="block min-w-0 flex-1 truncate">{file.name}</span>
            {file.unavailableReason && <span className="block text-xs text-muted-foreground">{file.unavailableReason}</span>}
            <span
              className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${
                isUpdateAvailable ? 'text-orange-500/90 dark:text-orange-300' : 'text-muted-foreground'
              }`}
            >
              {file.modifiedAt && <span>{formatModifiedAt(file.modifiedAt)}</span>}
              {file.modifiedBy && <span>{file.modifiedBy}</span>}
              {file.sizeBytes != null && <span>{formatBytes(file.sizeBytes)}</span>}
              {isUpdateAvailable && (
                <span className="rounded border border-orange-300 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-orange-600 dark:border-orange-700 dark:text-orange-300">
                  {t('sources.sourceFileRow.updateAvailable')}
                </span>
              )}
            </span>
          </span>
        </button>
        {downloadState && <SourceDownloadStatus name={file.name} state={downloadState} />}
        <button
          type="button"
          className={`mt-0.5 shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground ${
            favourited ? 'text-amber-500' : 'text-muted-foreground'
          }`}
          aria-label={
            favourited
              ? t('sources.sourceFileRow.removeFavouriteAria', { name: file.name })
              : t('sources.sourceFileRow.addFavouriteAria', { name: file.name })
          }
          aria-pressed={favourited}
          onClick={onToggleFavourite}
        >
          <Star className={`h-3.5 w-3.5 ${favourited ? 'fill-current' : ''}`} />
        </button>
        {isLoadedInHierarchy && (
          <span className="flex shrink-0 items-center gap-1">
            <span
              className="rounded border border-emerald-300 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
              title={
                loadedModelNames.length > 0
                  ? t('sources.sourceFileRow.loadedTooltip', { names: loadedModelNames.join(', ') })
                  : t('sources.sourceFileRow.loadedTooltipEmpty')
              }
            >
              {t('sources.sourceFileRow.loadedBadge', { count: loadedModelNames.length })}
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('sources.sourceFileRow.syncAria', { name: file.name })}
              disabled={syncingFile || Boolean(file.unavailableReason)}
              onClick={onSyncLoadedFile}
            >
              <SourceSyncIcon name={file.name} syncing={syncingFile} state={syncState} />
            </button>
          </span>
        )}
      </div>
      {details && <SourceResourceDetails {...details} file={file} />}
    </li>
  );
}

/** Provider-supplied ISO timestamp -> short local date; falls back to the raw
 *  string when the provider sent something unparsable. */
function formatModifiedAt(modifiedAt: string): string {
  const ms = Date.parse(modifiedAt);
  if (Number.isNaN(ms)) return modifiedAt;
  return new Date(ms).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
