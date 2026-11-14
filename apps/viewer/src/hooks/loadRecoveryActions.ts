/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exact-operation actions shared by error cards and palette rows (#8947). */
import { useViewerStore, type ViewerState } from '@/store';
import { selectLoadCanceller } from '@/store/slices/loadingSlice';
import type { TranslationKey } from '@/i18n';

export function bindLoadRecovery(s: ViewerState = useViewerStore.getState()) {
  const cancel = selectLoadCanceller(s);
  const { error, lastLoadRetry, loadErrorSeq } = s;
  const errorIsCurrent = () => {
    const live = useViewerStore.getState();
    return error !== null && live.loadErrorSeq === loadErrorSeq
      && live.error === error && live.lastLoadRetry === lastLoadRetry;
  };
  return {
    unavailable(action: 'cancel' | 'retry' | 'dismiss'): TranslationKey | null {
      if (action === 'cancel') return cancel && selectLoadCanceller(useViewerStore.getState()) === cancel
        ? null : 'commandPalette.availability.noLoad';
      if (useViewerStore.getState().error === null) return 'commandPalette.availability.noLoadError';
      if (!errorIsCurrent()) return 'commandPalette.availability.loadErrorReplaced';
      if (action === 'retry' && !lastLoadRetry) return 'commandPalette.availability.noLoadRetry';
      return null;
    },
    cancel() {
      if (cancel && selectLoadCanceller(useViewerStore.getState()) === cancel) cancel();
    },
    retry() {
      if (errorIsCurrent() && lastLoadRetry) {
        // Consume this failure for every binding before the loader can yield.
        // The canonical clear also retires its retry and advances loadErrorSeq;
        // a newly reported failure remains independently retryable, even if
        // this callback throws synchronously. Never restore a stale failure.
        useViewerStore.getState().setError(null);
        lastLoadRetry();
      }
    },
    dismiss() {
      if (errorIsCurrent()) useViewerStore.getState().setError(null);
    },
  };
}
export type LoadRecoveryBinding = ReturnType<typeof bindLoadRecovery>;
