/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The in-viewport loading card (#5849). A model load showed its progress only
 * as a small bar in the toolbar, far from where the user is looking, and an
 * IFC load could not be cancelled at all. While `loading` is true this card
 * sits in the middle of the viewport with the file name, the phase and a
 * percentage (indeterminate when unknown) and a Cancel button when the load
 * has published a canceller (see `hooks/primaryLoadCanceller.ts`).
 */

import { Loader2, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { Progress } from '@/components/ui/progress';

export function ViewportLoadingCard() {
  const { t } = useTranslation();
  const loading = useViewerStore((s) => s.loading);
  const progress = useViewerStore(selectActiveLoadProgress);
  const cancel = useViewerStore((s) => s.activeStreamCanceller);
  // The model still loading: its record is registered before parsing begins.
  const fileName = useViewerStore((s) => {
    for (const model of s.models.values()) {
      if (model.loadState !== 'complete' && model.loadState !== 'error') return model.name;
    }
    return null;
  });
  if (!loading) return null;

  const percent = Math.round(progress?.percent ?? 0);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
      <div data-viewport-loading-card className="pointer-events-auto w-full max-w-sm rounded-lg border bg-background/95 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={fileName ?? undefined}>
            {fileName
              ? t('viewportLighting.container.loadingCard.title', { name: fileName })
              : t('viewportLighting.container.loadingCard.titleFallback')}
          </p>
        </div>
        {/* The live region: phase and percentage are announced as they change. */}
        <output aria-live="polite" className="mt-2 block truncate text-xs text-muted-foreground">
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
