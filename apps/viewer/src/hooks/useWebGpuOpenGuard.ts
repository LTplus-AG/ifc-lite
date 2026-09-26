/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one WebGPU capability check for every way to open a model — the file
 * picker, a drop, "Start blank", and the `?model=` autoload (#5851). Before
 * this, only `ViewportWelcomeCard.tsx` checked (and only to grey out its own
 * buttons); `handleDrop` in `ViewportContainer.tsx` and the `?model=`
 * autoload in `ViewerLayout.tsx` returned silently instead. `guard` shows
 * the load-error card with an explanation and, when the caller supplies one,
 * a Retry closing over the same attempt.
 */

import { useCallback, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { showLoadError } from '@/lib/analytics';
import { getWebGPUStatus, retryWebGPU, useWebGPU, type WebGPUStatus } from './useWebGPU';

export interface WebGpuOpenGuard {
  webgpu: WebGPUStatus;
  /**
   * True when WebGPU is supported. Otherwise false and shows a reason in the
   * load-error card, including while the adapter check is still pending.
   */
  guard: (retry?: () => void) => boolean;
}

export function useWebGpuOpenGuard(): WebGpuOpenGuard {
  const webgpu = useWebGPU();
  const { t } = useTranslation();

  useEffect(() => {
    if (webgpu.checking || webgpu.supported) return;
    const state = useViewerStore.getState();
    if (state.error !== t('viewportLighting.container.loadErrorCard.webgpuChecking')) return;
    showLoadError(
      state.setError, state.setLastLoadRetry,
      t('viewportLighting.container.loadErrorCard.webgpuUnsupported'),
      'webgpu_unsupported', state.lastLoadRetry,
    );
  }, [t, webgpu.checking, webgpu.supported]);

  const guard = useCallback((retry?: () => void): boolean => {
    const status = getWebGPUStatus();
    if (status.supported) return true;
    // Explains a drop/open even while the adapter check is still pending,
    // instead of a silent no-op — the caller has no separate "wait" path.
    const { setError, setLastLoadRetry } = useViewerStore.getState();
    const retryAfterProbe: (() => void) | null = retry ? () => {
      if (getWebGPUStatus().supported) {
        retry();
        return;
      }
      void retryWebGPU().then((fresh) => {
        if (fresh.supported) {
          retry();
          return;
        }
        const state = useViewerStore.getState();
        showLoadError(
          state.setError, state.setLastLoadRetry,
          t('viewportLighting.container.loadErrorCard.webgpuUnsupported'),
          'webgpu_unsupported', retryAfterProbe,
        );
      });
    } : null;
    showLoadError(
      setError, setLastLoadRetry,
      t(status.checking
        ? 'viewportLighting.container.loadErrorCard.webgpuChecking'
        : 'viewportLighting.container.loadErrorCard.webgpuUnsupported'),
      status.checking ? 'webgpu_checking' : 'webgpu_unsupported',
      retryAfterProbe,
    );
    return false;
  }, [t]);

  return { webgpu, guard };
}
