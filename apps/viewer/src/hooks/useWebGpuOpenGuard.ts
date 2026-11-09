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

export interface WebGpuOpenGuardOptions {
  /**
   * Run `retry` by itself once a pending capability check reports WebGPU
   * supported. Opt in only for an open that is safe to replay without a fresh
   * user gesture (a dropped file, a `?model=` URL). A picker or other
   * activation-gated action must not set it: replayed from an effect, it has no
   * user activation. Without it, a passing check just clears the notice.
   */
  resumeWhenSupported?: boolean;
}

export interface WebGpuOpenGuard {
  webgpu: WebGPUStatus;
  /**
   * True when WebGPU is supported. Otherwise false and shows a reason in the
   * load-error card, including while the adapter check is still pending.
   */
  guard: (retry?: () => void, options?: WebGpuOpenGuardOptions) => boolean;
}

const CHECKING_KEY = 'viewportLighting.container.loadErrorCard.webgpuChecking';
const UNSUPPORTED_KEY = 'viewportLighting.container.loadErrorCard.webgpuUnsupported';

/** Where the shared adapter probe stands, as the open guard acts on it. */
type OpenGuardProbe =
  | { kind: 'checking' }
  | { kind: 'supported' }
  | { kind: 'unsupported'; reason: string | null };

function probeOf(status: WebGPUStatus): OpenGuardProbe {
  if (status.supported) return { kind: 'supported' };
  return status.checking ? { kind: 'checking' } : { kind: 'unsupported', reason: status.reason };
}

/**
 * The "still being checked" notice an open put on the load-error card. It is
 * identified by the exact message and Retry it set, never by re-translating
 * the text, so a locale switch or a newer load error cannot be mistaken for it.
 * Module-level because the viewport and the URL autoload both mount the guard
 * over one shared probe; whichever instance sees the probe settle first
 * consumes it.
 */
let pendingNotice: { message: string; retryHandle: (() => void) | null; open: (() => void) | null } | null = null;

export function useWebGpuOpenGuard(): WebGpuOpenGuard {
  const webgpu = useWebGPU();
  // `t` is one stable function; `revision` is what changes on a locale switch.
  const { t, revision } = useTranslation();

  useEffect(() => {
    const notice = pendingNotice;
    if (!notice) return;
    const state = useViewerStore.getState();
    if (state.error !== notice.message || state.lastLoadRetry !== notice.retryHandle) {
      pendingNotice = null; // dismissed, or replaced by a newer error
      return;
    }
    const probe = probeOf(webgpu);
    switch (probe.kind) {
      case 'checking': {
        const message = t(CHECKING_KEY);
        if (message === notice.message) return;
        pendingNotice = { ...notice, message };
        state.setError(message);
        return;
      }
      case 'supported':
        pendingNotice = null;
        state.setError(null);
        notice.open?.(); // the open that was waiting on the check
        return;
      case 'unsupported':
        pendingNotice = null;
        showLoadError(state.setError, state.setLastLoadRetry, t(UNSUPPORTED_KEY), 'webgpu_unsupported', notice.retryHandle);
    }
  }, [t, revision, webgpu]);

  const guard = useCallback((retry?: () => void, options?: WebGpuOpenGuardOptions): boolean => {
    const status = getWebGPUStatus();
    if (status.supported) return true;
    // Explains a drop/open even while the adapter check is still pending,
    // instead of a silent no-op — the caller has no separate "wait" path.
    const { setError, setLastLoadRetry } = useViewerStore.getState();
    let retryPending = false;
    const retryAfterProbe: (() => void) | null = retry ? () => {
      const current = useViewerStore.getState();
      if (retryPending || current.lastLoadRetry !== retryAfterProbe) return;
      retryPending = true;
      // Retry now owns this open; the settled check must not run it as well.
      if (pendingNotice?.retryHandle === retryAfterProbe) pendingNotice = null;
      if (getWebGPUStatus().supported) {
        retry();
        return;
      }
      void retryWebGPU().then((fresh) => {
        const state = useViewerStore.getState();
        if (state.lastLoadRetry !== retryAfterProbe) return;
        if (fresh.supported) {
          retry();
          return;
        }
        retryPending = false;
        showLoadError(state.setError, state.setLastLoadRetry, t(UNSUPPORTED_KEY), 'webgpu_unsupported', retryAfterProbe);
      });
    } : null;
    const checking = probeOf(status).kind === 'checking';
    const message = t(checking ? CHECKING_KEY : UNSUPPORTED_KEY);
    const open = options?.resumeWhenSupported ? retry ?? null : null;
    pendingNotice = checking ? { message, retryHandle: retryAfterProbe, open } : null;
    showLoadError(setError, setLastLoadRetry, message, checking ? 'webgpu_checking' : 'webgpu_unsupported', retryAfterProbe);
    return false;
  }, [t]);

  return { webgpu, guard };
}
