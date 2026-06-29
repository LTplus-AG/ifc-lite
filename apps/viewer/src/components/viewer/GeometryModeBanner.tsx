/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reload-to-apply banner for the "Fast / Exact geometry" load-time mode,
 * mirroring {@link MergeLayersBanner}. The user flips the mode in the Visibility
 * dropdown; when a model is already loaded the store sets
 * `geometryModePendingReload` and we surface this non-modal banner above the
 * canvas asking the user to reload (re-tessellating with the new mode).
 *
 * Anchored slightly below the merge-layers banner so the two don't overlap if
 * both are pending at once.
 */
import { useCallback } from 'react';
import { Zap, RefreshCw, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface GeometryModeBannerProps {
  /**
   * Overrides the default `window.location.reload()` fallback with an in-place
   * model reload (see ViewportContainer). Same contract as MergeLayersBanner.
   */
  onReload?: () => void;
}

export function GeometryModeBanner({ onReload }: GeometryModeBannerProps) {
  const pending = useViewerStore((s) => s.geometryModePendingReload);
  const mode = useViewerStore((s) => s.geometryMode);
  const dismiss = useViewerStore((s) => s.clearGeometryModePendingReload);

  const handleReload = useCallback(() => {
    if (onReload) {
      onReload();
      return;
    }
    // Full-page reload is the only guaranteed path: the viewer doesn't retain
    // the source File/handle once loading completes. The mode is persisted in
    // localStorage so it's picked up on the next boot.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, [onReload]);

  if (!pending) return null;

  return (
    <div className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 z-40 max-w-[min(640px,calc(100%-1.5rem))] w-fit">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'pointer-events-auto flex items-center gap-3 border border-primary/40 bg-background/95 backdrop-blur',
          'px-3 py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)] rounded-md',
          'animate-in slide-in-from-top-2 fade-in-0 duration-200',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Zap className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-xs font-semibold text-foreground">
            {mode === 'fast' ? 'Fast geometry enabled' : 'Exact geometry enabled'}
          </span>
          <span className="text-[11px] text-muted-foreground truncate">
            Reload model to apply the new setting.
          </span>
        </div>
        <div className="flex items-center gap-1.5 ml-2">
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2.5 gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
            onClick={handleReload}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-7 w-7"
            onClick={dismiss}
            aria-label="Dismiss reload reminder"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
