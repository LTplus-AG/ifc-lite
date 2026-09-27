/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app-wide "a new version is available, reload" notice (#5609).
 *
 * `ChunkErrorBoundary` covers a stale lazy chunk inside the panel that failed.
 * A stale geometry worker or engine binary has no panel to fall back in: the
 * load itself dies. This is that case's surface, raised through
 * `reportStaleDeployment` in ../lib/stale-deployment.ts. Persistent on purpose:
 * nothing in this tab can succeed until it reloads, so a toast that times out
 * would leave the user with no next step.
 *
 * Mount once per route, next to `Toaster`.
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { isStaleDeploymentReported, subscribeStaleDeployment } from '@/lib/stale-deployment';

export function StaleDeploymentNotice(): ReactNode {
  const { t } = useTranslation();
  const stale = useSyncExternalStore(subscribeStaleDeployment, isStaleDeploymentReported, isStaleDeploymentReported);
  if (!stale) return null;
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-4 z-[9999] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-800 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      <span>{t('viewerShell.staleDeployment.notice')}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
      >
        <RefreshCw className="h-3 w-3" aria-hidden />
        {t('viewerShell.chunkError.reload')}
      </button>
    </div>
  );
}
