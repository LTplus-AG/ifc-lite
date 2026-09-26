/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wiring for the in-viewport load-error card (#5851). One card replaces the
 * truncated error span the ribbon and classic toolbars used to render, and
 * the silent `console.error` the `?model=` autoload used to fail with.
 *
 * `error` and `lastLoadRetry` both live on `loadingSlice`. Every load path
 * (`useIfcLoader.loadFile`, every federated IFCX path in `useIfcFederation`,
 * the WebGPU guard, and the `?model=` autoload) reports failure through the
 * one shared `showLoadError` in `lib/analytics.ts`, which sets `error` and
 * `lastLoadRetry` TOGETHER — `retry` is a required argument there, not
 * optional, so no call site can show an error while
 * leaving a stale retry from whatever the previous, unrelated error was
 * (the bug a 2026-09 review caught: a federated-add failure left a primary
 * load's own retry sitting there). `setError(null)` also clears
 * `lastLoadRetry`, so success never leaves one behind either. There is no
 * second error path.
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';

export interface LoadErrorCardState {
  /** The full message to show; the card is not rendered when this is null. */
  error: string | null;
  /** Present only when the failed attempt can be replayed. */
  canRetry: boolean;
  /** Re-runs the exact attempt that set `error` — a `loadFile` call, a federated add, or the `?model=` autoload. */
  retry: () => void;
  /** Clears `error` and releases the captured retry source. */
  dismiss: () => void;
}

export function useLoadErrorCard(): LoadErrorCardState {
  const { error, lastLoadRetry, setError, setLastLoadRetry } = useViewerStore(useShallow((s) => ({
    error: s.error,
    lastLoadRetry: s.lastLoadRetry,
    setError: s.setError,
    setLastLoadRetry: s.setLastLoadRetry,
  })));

  const retry = useCallback(() => {
    lastLoadRetry?.();
  }, [lastLoadRetry]);

  const dismiss = useCallback(() => {
    setError(null);
    setLastLoadRetry(null);
  }, [setError, setLastLoadRetry]);

  return { error, canRetry: lastLoadRetry !== null, retry, dismiss };
}
