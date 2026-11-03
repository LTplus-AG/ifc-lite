/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen's recent-files list: everything the browser remembers (up
 * to ten), about four rows tall and scrolling past that.
 *
 * Only the newest few files under the size cap keep their bytes in this
 * browser (`recent-files.ts`), so each row says whether it reopens instantly
 * or has to be located again instead of promising an instant reopen.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { formatFileSize, getCachedFileNames, type RecentFileEntry } from '@/lib/recent-files';
import { formatBadge, recentWhen } from './recent-when';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const MUTED = 'text-zinc-500 dark:text-[#9aa3c7]';

export interface WelcomeRecentFilesProps {
  files: RecentFileEntry[];
  disabled: boolean;
  onOpen: (file: RecentFileEntry) => void;
}

export function WelcomeRecentFiles({ files, disabled, onOpen }: WelcomeRecentFilesProps) {
  const { t, locale } = useTranslation();
  const [cachedNames, setCachedNames] = useState<ReadonlySet<string>>(() => new Set());
  // Read once per list: relative times only need to be right when shown.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (files.length === 0) return;
    let live = true;
    void getCachedFileNames().then((names) => { if (live) setCachedNames(new Set(names)); });
    return () => { live = false; };
  }, [files]);

  if (files.length === 0) return null;

  return (
    <section className="mt-8">
      <h3 className={`mb-2 text-xs font-medium ${MUTED}`}>
        {t('viewportLighting.container.emptyState.recentFiles.heading')}
      </h3>
      <ul className="max-h-[13.5rem] overflow-y-auto overscroll-contain rounded-lg border border-zinc-200 bg-white/70 [scrollbar-width:thin] dark:border-[#262a3d] dark:bg-[#16161e]/70">
        {files.map((file) => {
          const cached = cachedNames.has(file.name);
          const badge = formatBadge(file.name);
          return (
            <li key={`${file.name}-${file.timestamp}`} className="border-b border-zinc-200 last:border-b-0 dark:border-[#262a3d]">
              <button
                type="button"
                onClick={() => onOpen(file)}
                disabled={disabled}
                title={cached ? undefined : t('viewportLighting.container.emptyState.recentFiles.locateHint')}
                className={`group grid w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-[#1f2335] ${FOCUS}`}
              >
                <span className="rounded bg-zinc-100 py-1 text-center font-mono text-2xs font-semibold text-zinc-600 dark:bg-[#1f2335] dark:text-[#a9b1d6]">
                  {badge}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-zinc-900 group-enabled:group-hover:text-primary dark:text-[#c0caf5]">
                    {file.name}
                  </span>
                  <span className={`block text-xs tabular-nums ${MUTED}`}>
                    {formatFileSize(file.size)} · {recentWhen(locale, file.timestamp, now)}
                  </span>
                </span>
                <span
                  className={`min-w-[4.5rem] rounded border px-1.5 py-0.5 text-center text-2xs ${
                    cached
                      ? 'border-zinc-300 text-zinc-700 dark:border-[#3b4261] dark:text-[#a9b1d6]'
                      : 'border-dashed border-zinc-300 text-zinc-500 dark:border-[#3b4261] dark:text-[#9aa3c7]'
                  }`}
                >
                  {cached
                    ? t('viewportLighting.container.emptyState.recentFiles.reopen')
                    : t('viewportLighting.container.emptyState.recentFiles.locate')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
