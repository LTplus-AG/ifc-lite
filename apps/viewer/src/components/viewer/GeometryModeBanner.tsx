/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reload-to-apply banner for the load-time geometry inputs, mirroring
 * {@link MergeLayersBanner}. The user changes one in the Visibility dropdown
 * (the Fast/Exact mode switch, or clearing a pinned `?geomTier=` detail
 * override); when a model is already loaded the store sets
 * `geometryModePendingReload` and we surface this non-modal banner above the
 * canvas asking the user to reload (re-tessellating with the new input).
 * `geometryReloadReason` picks the headline so the prompt names the change the
 * user actually made — one banner, two inputs.
 *
 * Stacked into the HUD's top-center region as a `HudNotice` (#5504, charter
 * #5478 item 22), below the merge-layers banner: the region's own
 * flex-column gap keeps the two from overlapping if both are pending at once,
 * rather than a hand-picked `top-*` offset.
 */
import { useCallback } from 'react';
import { Zap, RefreshCw, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudItem, HudNotice } from '../viewport-ui/hud';

export interface GeometryModeBannerProps {
  /**
   * Overrides the default `window.location.reload()` fallback with an in-place
   * model reload (see ViewportContainer). Same contract as MergeLayersBanner.
   */
  onReload?: () => void;
}

export function GeometryModeBanner({ onReload }: GeometryModeBannerProps) {
  const { t } = useTranslation();
  const pending = useViewerStore((s) => s.geometryModePendingReload);
  const mode = useViewerStore((s) => s.geometryMode);
  const reason = useViewerStore((s) => s.geometryReloadReason);
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
    <HudItem region="top-center" order={11}>
      <HudNotice
        tone="info"
        icon={<Zap className="h-4 w-4" />}
        title={
          reason === 'tier'
            ? t('geometryModeBanner.detailPinRemoved')
            : mode === 'fast'
              ? t('geometryModeBanner.fastEnabled')
              : t('geometryModeBanner.exactEnabled')
        }
        description={t('geometryModeBanner.reloadHint')}
        action={{
          label: (
            <span className="inline-flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t('geometryModeBanner.reloadButton')}
            </span>
          ),
          onClick: handleReload,
        }}
        dismiss={{
          onClick: dismiss,
          'aria-label': t('geometryModeBanner.dismissAriaLabel'),
          icon: <X className="h-3.5 w-3.5" />,
        }}
      />
    </HudItem>
  );
}
