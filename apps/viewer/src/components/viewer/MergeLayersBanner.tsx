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
 *
 * Stacked into the HUD's top-center region as a `HudNotice` (#5504, charter
 * #5478 item 22), alongside `GeometryModeBanner` and
 * `LandXmlUnitsRefusalPrompt`: the region's own flex-column gap keeps them
 * from overlapping, replacing three independently-positioned floating cards.
 */
import { useCallback } from 'react';
import { Layers2, RefreshCw, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudItem, HudNotice } from '../viewport-ui/hud';

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
  const { t } = useTranslation();

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
    <HudItem region="top-center" order={10}>
      <HudNotice
        tone="info"
        icon={<Layers2 className="h-4 w-4" />}
        title={merging ? t('mergeLayersBanner.titleEnabled') : t('mergeLayersBanner.titleDisabled')}
        description={t('mergeLayersBanner.subtitle')}
        action={{
          label: (
            <span className="inline-flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t('mergeLayersBanner.reloadButton')}
            </span>
          ),
          onClick: handleReload,
        }}
        dismiss={{
          onClick: dismiss,
          'aria-label': t('mergeLayersBanner.dismissAriaLabel'),
          icon: <X className="h-3.5 w-3.5" />,
        }}
      />
    </HudItem>
  );
}
