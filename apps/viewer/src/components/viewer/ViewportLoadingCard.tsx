/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The in-viewport loading card (#5849). A model load showed its progress only
 * as a small bar in the toolbar, far from where the user is looking, and an
 * IFC load could not be cancelled at all. While `loading` is true this card
 * sits in the middle of the viewport with the file name, the phase and a
 * percentage (indeterminate when unknown) and a Cancel button when the load
 * has published a canceller (see `hooks/modelLoadCanceller.ts`).
 */

import { X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectActiveLoadProgress, selectLoadCanceller } from '@/store/slices/loadingSlice';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';

export function ViewportLoadingCard() {
  const { t } = useTranslation();
  const loading = useViewerStore((s) => s.loading);
  const progress = useViewerStore(selectActiveLoadProgress);
  const cancel = useViewerStore(selectLoadCanceller);
  const fileName = useViewerStore((s) => s.loadingFileName);
  if (!loading) return null;

  const title = fileName
    ? t('viewportLighting.container.loadingCard.title', { name: fileName })
    : t('viewportLighting.container.loadingCard.titleFallback');

  const percent = Math.round(progress?.percent ?? 0);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
      <div data-viewport-loading-card className="pointer-events-auto w-full max-w-sm rounded-lg border bg-background/95 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Spinner size="md" className="shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={fileName ?? undefined} aria-hidden="true">
            {title}
          </p>
        </div>
        {/* The live region (an <output>, the jsx-a11y ratchet's stand-in for
            role="status"): which file, the phase and the percentage. */}
        <output aria-live="polite" className="mt-2 block truncate text-xs text-muted-foreground">
          <span className="sr-only">{title}: </span>
          {progress?.phase ?? t('viewportLighting.container.loadingCard.titleFallback')}
          {!progress?.indeterminate && ` · ${percent}%`}
        </output>
        <div className="mt-2 flex items-center gap-2">
          {progress?.indeterminate
            ? <div className="h-2 flex-1 overflow-hidden rounded-full bg-primary/20"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>
            : <Progress value={percent} className="h-2 flex-1" />}
        </div>
        {cancel && (
          <button
            type="button"
            onClick={() => cancel()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('viewportLighting.container.loadingCard.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
