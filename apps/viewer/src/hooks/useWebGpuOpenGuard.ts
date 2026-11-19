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
import { clearLoadError, showLoadError } from '@/lib/analytics';
import { getWebGPUStatus, retryWebGPU, useWebGPU, type WebGPUStatus } from './useWebGPU';

/**
 * How an open may be re-run without the click that started it:
 * - `'free'`: needs no user gesture (a dropped or input-selected file, a
 *   `?model=` fetch). It resumes by itself when a pending check passes, and
 *   Retry replays it.
 * - `'on-retry'`: needs no gesture either (Start blank), but only an explicit
 *   Retry replays it; a passing check just clears the card.
 * - `'activation'` (default): needs transient user activation (the file
 *   picker). Retry replays it only while the click's activation is still
 *   active (`navigator.userActivation.isActive`, about 5 s); otherwise the
 *   card clears and the user opens again. It never auto-resumes.
 */
export type OpenReplay = 'free' | 'on-retry' | 'activation';

export interface WebGpuOpenGuardOptions {
  replay?: OpenReplay;
}

export interface WebGpuOpenGuard {
  webgpu: WebGPUStatus;
  /**
   * True when WebGPU is supported. Otherwise false and shows a reason in the
   * load-error card, including while the adapter check is still pending. One
   * card at a time: a second open during the same check replaces the first
   * one's card and pending open.
   */
  guard: (retry?: () => void, options?: WebGpuOpenGuardOptions) => boolean;
}

const CHECKING_KEY = 'viewportLighting.container.loadErrorCard.webgpuChecking';
const UNSUPPORTED_KEY = 'viewportLighting.container.loadErrorCard.webgpuUnsupported';

type Translate = ReturnType<typeof useTranslation>['t'];

type CardKey = typeof CHECKING_KEY | typeof UNSUPPORTED_KEY;

/** The load-error card the guard put up: which text, exactly as shown, and its Retry. */
interface GuardCard { key: CardKey; message: string | null; retry: (() => void) | null }

/**
 * The guard's one piece of state: the card it is responsible for, if any.
 * - `none`: nothing of ours is waiting on the probe.
 * - `pending`: an open arrived while the check was running; `open` resumes it
 *   when the check passes (null when the caller did not opt in).
 * - `retrying`: the user pressed Retry; Retry owns `open` from here on. When
 *   the check is still running, `open` is kept only for an opted-in caller:
 *   by the time it passes, the click's user activation is gone.
 * Module-level because the viewport and the URL autoload mount the guard over
 * one shared probe. Only `settle` and the two entry points below change it, and
 * `settle` consumes it before running an open, so an open that re-enters
 * `guard` writes a fresh notice nothing overwrites.
 */
type GuardNotice =
  | { kind: 'none' }
  | { kind: 'pending'; card: GuardCard; open: (() => void) | null }
  | { kind: 'retrying'; card: GuardCard; open: () => void; needsActivation: boolean };

let notice: GuardNotice = { kind: 'none' };
let mountedGuards = 0;

function hasUserActivation(): boolean {
  return typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true;
}

/**
 * Still on screen as we left it: neither dismissed nor replaced by a newer
 * error. The Retry identity tells a newer card with the same text (another
 * open's, or a caller's own error) apart from ours.
 */
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
    // Still waiting: only the text follows the locale, whichever card is shown.
    const message = t(current.card.key);
    if (message === current.card.message) return;
    notice = { ...current, card: { ...current.card, message } };
    state.setError(message);
    return;
  }
  notice = { kind: 'none' };
  if (!status.supported) {
    showLoadError(state.setError, state.setLastLoadRetry, t(UNSUPPORTED_KEY), 'webgpu_unsupported', current.card.retry);
    return;
  }
  clearLoadError(state.setError, state.setLastLoadRetry);
  if (!current.open) return;
  // A picker replayed after its click's activation expired is blocked silently.
  if (current.kind === 'retrying' && current.needsActivation && !hasUserActivation()) return;
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
  // With no guard left to settle it, drop the notice (and our card) rather than
  // let a later mount replay an open captured by an unmounted component.
  useEffect(() => {
    mountedGuards += 1;
    return () => {
      mountedGuards -= 1;
      if (mountedGuards > 0 || notice.kind === 'none') return;
      const { card } = notice;
      notice = { kind: 'none' };
      if (owns(card)) clearLoadError(useViewerStore.getState().setError, useViewerStore.getState().setLastLoadRetry);
    };
  }, []);

  const guard = useCallback((retry?: () => void, options?: WebGpuOpenGuardOptions): boolean => {
    const status = getWebGPUStatus();
    if (status.supported) return true;
    // Explains a drop/open even while the adapter check is still pending,
    // instead of a silent no-op — the caller has no separate "wait" path.
    const { setError, setLastLoadRetry } = useViewerStore.getState();
    const replay = options?.replay ?? 'activation';
    const retryAfterProbe: (() => void) | null = retry ? () => {
      const { error, lastLoadRetry } = useViewerStore.getState();
      if (lastLoadRetry !== retryAfterProbe) return; // a stale card's Retry starts no re-check
      // Our card is the pending checking one, or else the unsupported one.
      const key = notice.kind !== 'none' && notice.card.retry === retryAfterProbe ? notice.card.key : UNSUPPORTED_KEY;
      const card = { key, message: error, retry: retryAfterProbe };
      const now = getWebGPUStatus();
      if (now.supported) {
        // Settles synchronously, inside the click, so even the picker has its activation.
        notice = { kind: 'retrying', card, open: retry, needsActivation: false };
        settle(now, t);
        return;
      }
      // The effect settles it when the (shared, or re-forced) probe reports;
      // a second click before then only re-arms the same notice.
      notice = { kind: 'retrying', card, open: retry, needsActivation: replay === 'activation' };
      void retryWebGPU();
    } : null;
    const checking = status.checking;
    const key = checking ? CHECKING_KEY : UNSUPPORTED_KEY;
    const message = t(key);
    notice = checking
      ? { kind: 'pending', card: { key, message, retry: retryAfterProbe }, open: replay === 'free' ? retry ?? null : null }
      : { kind: 'none' };
    showLoadError(setError, setLastLoadRetry, message, checking ? 'webgpu_checking' : 'webgpu_unsupported', retryAfterProbe);
    return false;
  }, [t]);

  return { webgpu, guard };
}
