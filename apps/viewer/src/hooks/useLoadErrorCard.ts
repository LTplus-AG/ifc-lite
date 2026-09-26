/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wiring for the in-viewport load-error card (#5851). One card replaces the
 * truncated error span the ribbon and classic toolbars used to render, and
 * the silent `console.error` the `?model=` autoload used to fail with.
 *
 * `error` and `lastLoadRetry` both live on `loadingSlice` and share its
 * lifecycle: every load path (`useIfcLoader.loadFile`, the federated IFCX
 * paths in `useIfcFederation`, and the `?model=` autoload in `ViewerLayout`)
 * sets `lastLoadRetry` to a closure over that exact attempt before it can
 * fail, and reports failure through the one shared `showLoadError` helper in
 * `lib/analytics.ts`. There is no second error path.
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';

export interface LoadErrorCardState {
  /** The full message to show; the card is not rendered when this is null. */
  error: string | null;
  /** Present only when the failed attempt can be replayed. */
  canRetry: boolean;
  /** Re-runs the load that set `error`, same File or URL, through `loadFile`. */
  retry: () => void;
  /** Clears `error` without retrying. */
  dismiss: () => void;
}

export function useLoadErrorCard(): LoadErrorCardState {
  const { error, lastLoadRetry, setError } = useViewerStore(useShallow((s) => ({
    error: s.error,
    lastLoadRetry: s.lastLoadRetry,
    setError: s.setError,
  })));

  const retry = useCallback(() => {
    lastLoadRetry?.();
  }, [lastLoadRetry]);

  const dismiss = useCallback(() => {
    setError(null);
  }, [setError]);

  return { error, canRetry: lastLoadRetry !== null, retry, dismiss };
}
