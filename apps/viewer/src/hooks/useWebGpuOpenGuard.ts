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
   * user gesture (a dropped or input-selected file). A picker or other
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

type Translate = ReturnType<typeof useTranslation>['t'];

/** The load-error card the guard put up: its exact text and Retry, never re-translated. */
interface GuardCard { message: string | null; retry: (() => void) | null }

/**
 * The guard's one piece of state: the card it is responsible for, if any.
 * - `none`: nothing of ours is waiting on the probe.
 * - `pending`: an open arrived while the check was running; `open` resumes it
 *   when the check passes (null when the caller did not opt in).
 * - `retrying`: the user pressed Retry; Retry owns `open` from here on.
 * Module-level because the viewport and the URL autoload mount the guard over
 * one shared probe. Only `settle` and the two entry points below change it, and
 * `settle` consumes it before running an open, so an open that re-enters
 * `guard` writes a fresh notice nothing overwrites.
 */
type GuardNotice =
  | { kind: 'none' }
  | { kind: 'pending'; card: GuardCard; open: (() => void) | null }
  | { kind: 'retrying'; card: GuardCard; open: () => void };

let notice: GuardNotice = { kind: 'none' };

/** Still on screen as we left it: neither dismissed nor replaced by a newer error. */
function owns(card: GuardCard): boolean {
  const { error, lastLoadRetry } = useViewerStore.getState();
  return error === card.message && lastLoadRetry === card.retry;
}

/** The probe moved on: hand the card to its next state, running a waiting open at most once. */
function settle(status: WebGPUStatus, t: Translate): void {
  const current = notice;
  if (current.kind === 'none') return;
  if (!owns(current.card)) { notice = { kind: 'none' }; return; }
  const state = useViewerStore.getState();
  if (status.checking) {
    // Still waiting: only the text follows the locale (Retry keeps its card as is).
    const message = t(CHECKING_KEY);
    if (current.kind !== 'pending' || message === current.card.message) return;
    notice = { ...current, card: { ...current.card, message } };
    state.setError(message);
    return;
  }
  notice = { kind: 'none' };
  if (!status.supported) {
    showLoadError(state.setError, state.setLastLoadRetry, t(UNSUPPORTED_KEY), 'webgpu_unsupported', current.card.retry);
    return;
  }
  state.setError(null); // clears the card and its Retry together
  if (!current.open) return;
  try {
    current.open();
  } catch (err) {
    console.error('[WebGPU] resuming the pending open failed:', err);
    showLoadError(state.setError, state.setLastLoadRetry,
      err instanceof Error ? err.message : String(err), 'webgpu_resume_failed', null);
  }
}

export function useWebGpuOpenGuard(): WebGpuOpenGuard {
  const webgpu = useWebGPU();
  // `t` is one stable function; `revision` is what changes on a locale switch.
  const { t, revision } = useTranslation();

  useEffect(() => { settle(webgpu, t); }, [t, revision, webgpu]);

  const guard = useCallback((retry?: () => void, options?: WebGpuOpenGuardOptions): boolean => {
    const status = getWebGPUStatus();
    if (status.supported) return true;
    // Explains a drop/open even while the adapter check is still pending,
    // instead of a silent no-op — the caller has no separate "wait" path.
    const { setError, setLastLoadRetry } = useViewerStore.getState();
    const retryAfterProbe: (() => void) | null = retry ? () => {
      const { error, lastLoadRetry } = useViewerStore.getState();
      if (lastLoadRetry !== retryAfterProbe) return; // stale card
      notice = { kind: 'retrying', card: { message: error, retry: retryAfterProbe }, open: retry };
      // The effect settles it when the (shared, or re-forced) probe reports;
      // a second click before then only re-arms the same notice.
      const now = getWebGPUStatus();
      if (now.supported) settle(now, t);
      else void retryWebGPU();
    } : null;
    const checking = status.checking;
    const message = t(checking ? CHECKING_KEY : UNSUPPORTED_KEY);
    notice = checking
      ? { kind: 'pending', card: { message, retry: retryAfterProbe }, open: options?.resumeWhenSupported ? retry ?? null : null }
      : { kind: 'none' };
    showLoadError(setError, setLastLoadRetry, message, checking ? 'webgpu_checking' : 'webgpu_unsupported', retryAfterProbe);
    return false;
  }, [t]);

  return { webgpu, guard };
}
