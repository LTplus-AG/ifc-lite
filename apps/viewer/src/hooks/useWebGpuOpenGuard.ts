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

import { useCallback } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { showLoadError } from '@/lib/analytics';
import { useWebGPU, type WebGPUStatus } from './useWebGPU';

export interface WebGpuOpenGuard {
  webgpu: WebGPUStatus;
  /**
   * True and does nothing while WebGPU is supported (or still checking, so
   * a click just before the check resolves is a silent no-op, matching the
   * disabled welcome-card buttons). False and shows the card otherwise.
   */
  guard: (retry?: () => void) => boolean;
}

export function useWebGpuOpenGuard(): WebGpuOpenGuard {
  const webgpu = useWebGPU();
  const { t } = useTranslation();

  const guard = useCallback((retry?: () => void): boolean => {
    if (webgpu.supported) return true;
    if (webgpu.checking) return false; // not resolved yet — a caller on a timer should wait for it, not fail
    useViewerStore.getState().setLastLoadRetry(retry ?? null);
    showLoadError(
      useViewerStore.getState().setError,
      t('viewportLighting.container.loadErrorCard.webgpuUnsupported'),
      'webgpu_unsupported',
    );
    return false;
  }, [webgpu, t]);

  return { webgpu, guard };
}
