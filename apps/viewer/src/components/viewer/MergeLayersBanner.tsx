/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reload-to-apply banner for the "Merge Multilayer Walls" load-time
 * toggle (issue #540). The user flips the toggle in the Class
 * Visibility dropdown; when a model is already loaded, the UI sets
 * `mergeLayersPendingReload` and we surface this non-modal banner
 * above the canvas asking the user to reload.
 *
 * Design note: this codebase has no "reload current model" function
 * — `useIfcLoader.loadFile` is one-shot and does not retain the
 * source File / NativeFileHandle. The pragmatic approach here is to
 * call `window.location.reload()` for the Reload button, which is
 * exactly what the wording promises ("Reload model to apply") and
 * works on both web and the Tauri shell (which keeps its window).
 * If a true in-place reload lands later, swap the handler — the
 * banner contract stays the same.
 */
import { useCallback } from 'react';
import { Layers2, RefreshCw, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MergeLayersBannerProps {
  /**
   * When set, this overrides the default `window.location.reload()`
   * fallback. Once a true "reload current model in place" path lands,
   * the caller can pass it in here without changing the banner's
   * visual contract.
   */
  onReload?: () => void;
}

export function MergeLayersBanner({ onReload }: MergeLayersBannerProps) {
  const pending = useViewerStore((s) => s.mergeLayersPendingReload);
  const merging = useViewerStore((s) => s.mergeLayers);
  const dismiss = useViewerStore((s) => s.clearMergeLayersPendingReload);

  const handleReload = useCallback(() => {
    if (onReload) {
      onReload();
      return;
    }
    // Full-page reload is the only path we can guarantee works: the
    // viewer doesn't retain the source File/handle once loading
    // completes, so we can't re-run loadFile with the original input.
    // The toggle is already persisted in localStorage so it will pick
    // up the new value on the next boot.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, [onReload]);

  if (!pending) return null;

  return (
    // Centred non-modal overlay anchored to the top of the canvas.
    // pointer-events-none on the wrapper lets clicks pass through
    // unless they land on the inner card, so the underlying 3D
    // viewport stays interactive.
    <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-40 max-w-[min(640px,calc(100%-1.5rem))] w-fit">
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
          <Layers2 className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-xs font-semibold text-foreground">
            Merge Multilayer Walls {merging ? 'enabled' : 'disabled'}
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
