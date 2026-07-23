/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceFile } from '@ifc-lite/plugin-api';
import type { DownloadedSourceFileStatus } from '@/lib/sources/persistence';
import { FileBox, RefreshCw } from 'lucide-react';

interface SourceFileRowProps {
  file: SourceFile;
  selected: boolean;
  onToggle: () => void;
  loadedModelNames: readonly string[];
  syncingFile: boolean;
  onSyncLoadedFile: () => void;
  downloadedStatus: DownloadedSourceFileStatus;
}

export function SourceFileRow({
  file,
  selected,
  onToggle,
  loadedModelNames,
  syncingFile,
  onSyncLoadedFile,
  downloadedStatus,
}: SourceFileRowProps) {
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
          onChange={onToggle}
          aria-label={selected ? `Deselect ${file.name}` : `Select ${file.name}`}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={onToggle}
        >
          <FileBox
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              isUpdateAvailable ? 'text-orange-500 dark:text-orange-400' : 'text-muted-foreground'
            }`}
          />
          <span className="min-w-0 flex-1">
            <span className="block min-w-0 flex-1 truncate">{file.name}</span>
            <span
              className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${
                isUpdateAvailable ? 'text-orange-500/90 dark:text-orange-300' : 'text-muted-foreground'
              }`}
            >
              <span>v{file.revisions[0]?.version ?? 1}</span>
              {file.sizeBytes != null && <span>{formatBytes(file.sizeBytes)}</span>}
              {isUpdateAvailable && (
                <span className="rounded border border-orange-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-600 dark:border-orange-700 dark:text-orange-300">
                  Update available
                </span>
              )}
            </span>
          </span>
        </button>
        {isLoadedInHierarchy && (
          <span className="flex shrink-0 items-center gap-1">
            <span
              className="rounded border border-emerald-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
              title={
                loadedModelNames.length > 0
                  ? `Loaded in hierarchy: ${loadedModelNames.join(', ')}`
                  : 'Loaded in hierarchy'
              }
            >
              {loadedModelNames.length > 1 ? `${loadedModelNames.length} loaded` : 'Loaded'}
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Sync ${file.name} from source`}
              disabled={syncingFile}
              onClick={onSyncLoadedFile}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncingFile ? 'animate-spin' : ''}`} />
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
