/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One answer to "is this tab running an out-of-date deployment?", and one
 * persistent "reload to continue" notice for when it is (#5609).
 *
 * A tab left open across a deploy loses its content-hashed assets three ways:
 * a lazy JS/CSS chunk (./chunk-version-skew.ts), the engine binary, and the
 * geometry worker script (both ./wasm-version-skew.ts). Each sibling reloads
 * the tab once, debounced. When that reload is refused (already spent in this
 * window, or storage blocked so it cannot be bounded), the failure used to reach
 * the user as a long, generic load error. The code already knew the cause, so
 * the user gets the next step instead: {@link reportStaleDeployment} raises the
 * notice `StaleDeploymentNotice` renders.
 *
 * No new matchers here: the predicate is the union of the ones the three
 * recovery paths already use, so detection cannot drift between them.
 */

import { isWasmAssetUnavailableError, isWorkerScriptSkewMessage } from '@ifc-lite/geometry';
import { isChunkLoadError } from './chunk-load-error.js';

/** True when `err` means an asset of this deployment is gone, not that the model or code is broken. */
export function isStaleDeploymentError(err: unknown): boolean {
  return isChunkLoadError(err) || isWorkerScriptSkewMessage(err) || isWasmAssetUnavailableError(err);
}

// Module memory, never storage: a reload is the fix, and it must land clean.
let reported = false;
let offlineChunkFailure = false;
const listeners = new Set<() => void>();

/** Raise the reload notice. Idempotent; the notice stays up until the page reloads. */
export function reportStaleDeployment(): void {
  if (reported) return;
  reported = true;
  notifyListeners();
}

export function reportOfflineChunkFailure(): void {
  if (offlineChunkFailure) return;
  offlineChunkFailure = true;
  notifyListeners();
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function getDeploymentNotice(): 'offline' | 'stale' | 'reconnected' | null {
  if (offlineChunkFailure && typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (reported) return 'stale';
  return offlineChunkFailure ? 'reconnected' : null;
}

/**
 * Load-failure routing for the model loader: a stale deployment raises the
 * notice and returns `true`, so the caller skips its generic error text.
 */
export function surfaceStaleDeployment(err: unknown): boolean {
  if (!isStaleDeploymentError(err)) return false;
  if (isChunkLoadError(err) && typeof navigator !== 'undefined' && navigator.onLine === false) {
    reportOfflineChunkFailure();
  } else {
    reportStaleDeployment();
  }
  return true;
}

export function isStaleDeploymentReported(): boolean {
  return reported;
}

/** `useSyncExternalStore` subscribe. */
export function subscribeStaleDeployment(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', listener);
    window.addEventListener('offline', listener);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', listener);
      window.removeEventListener('offline', listener);
    }
  };
}

/** Test-only: clear the flag between cases. */
export function __resetStaleDeploymentForTests(): void {
  reported = false;
  offlineChunkFailure = false;
}
