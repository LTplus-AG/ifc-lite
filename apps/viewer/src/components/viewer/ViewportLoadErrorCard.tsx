/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one in-viewport load-error card (#5851). Every load path — the file
 * picker, a drop, the ribbon/classic/mobile toolbars' Open, the `?model=`
 * autoload, and a federated add — reports failure through the shared
 * `showLoadError` helper (`lib/analytics.ts`), which sets `error` on the
 * store; this is the one place that error is shown. It replaces the
 * truncated, non-dismissible error span the ribbon and classic toolbars used
 * to render, and the silent `console.error` a `?model=` failure used to
 * leave behind.
 *
 * `role="alert"` (not the loading card's `<output>`): unlike a progress
 * update, a load failure was not expected by the user and needs their
 * attention immediately, which is exactly what an alert live region is for.
 */

import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useLoadErrorCard } from '@/hooks/useLoadErrorCard';

export function ViewportLoadErrorCard() {
  const { t } = useTranslation();
  const { error, canRetry, retry, dismiss } = useLoadErrorCard();
  if (!error) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-(--z-float) flex items-center justify-center p-4">
      <div
        role="alert"
        data-viewport-load-error-card
        className="pointer-events-auto w-full max-w-sm rounded-lg border border-destructive/40 bg-background/95 p-4 shadow-lg backdrop-blur-sm"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-destructive">{t('viewportLighting.container.loadErrorCard.title')}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {canRetry && (
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center rounded-md border px-2.5 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('viewportLighting.container.loadErrorCard.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('viewportLighting.container.loadErrorCard.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
