/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Compact background-load progress; the viewport remains navigable. */
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectActiveLoadProgress, selectLoadCanceller } from '@/store/slices/loadingSlice';
import { Spinner } from '@/components/ui/spinner';
import { mobileCommandPlacement } from '@/lib/layout/form-factor';
import { mobileNavRowClearance, mobileNavRowStyle } from './mobile-overlay-layout';

/** Existing producers publish detailed English phases; compact labels are presentation only. */
function compactPhase(phase: string | undefined) {
  if (/render|upload/i.test(phase ?? '')) return 'rendering';
  if (/geometry|mesh/i.test(phase ?? '')) return 'geometry';
  if (/metadata|propert|hydrat/i.test(phase ?? '')) return 'metadata';
  if (/pars|decod/i.test(phase ?? '')) return 'parsing';
  return 'reading';
}

export function ViewportLoadingCard() {
  const { t } = useTranslation();
  const loading = useViewerStore((s) => s.loading);
  const progress = useViewerStore(selectActiveLoadProgress);
  const cancel = useViewerStore(selectLoadCanceller);
  const fileName = useViewerStore((s) => s.loadingFileName);
  const isMobile = useViewerStore((s) => s.isMobile);
  const placement = useViewerStore((s) => mobileCommandPlacement(s.formFactor));
  if (!loading) return null;

  const title = fileName
    ? t('viewportLighting.container.loadingCard.title', { name: fileName })
    : t('viewportLighting.container.loadingCard.titleFallback');
  const phase = progress?.phase ?? title;
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const indeterminate = !progress || progress.indeterminate;
  const details = `${title}: ${phase}${indeterminate ? '' : ` · ${percent}%`}`;

  return (
    <div
      data-viewport-loading-card
      className="pointer-events-auto absolute bottom-4 right-4 z-30 w-max min-w-27 max-w-[calc(100%-2rem)] rounded-md border bg-background/95 px-2 py-1 shadow-sm backdrop-blur-sm"
      style={isMobile ? { ...mobileNavRowStyle(placement, 'right'), bottom: mobileNavRowClearance(placement) } : undefined}
      title={details}
    >
      <div className="flex items-center gap-1.5">
        <Spinner size="xs" className="shrink-0 text-primary motion-reduce:animate-none" />
        <output aria-live="polite" className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          <span aria-hidden="true">{t(`viewportLighting.container.loadingCard.phase.${compactPhase(progress?.phase)}`)}</span>
          <span className="sr-only">{details}</span>
        </output>
        {cancel && (
          <button
            type="button"
            onClick={() => cancel()}
            aria-label={t('viewportLighting.container.loadingCard.cancel')}
            title={t('viewportLighting.container.loadingCard.cancel')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <div aria-hidden="true" className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-primary/20">
        <div
          className={indeterminate ? 'h-full w-1/3 animate-pulse rounded-full bg-primary motion-reduce:animate-none' : 'h-full rounded-full bg-primary'}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
