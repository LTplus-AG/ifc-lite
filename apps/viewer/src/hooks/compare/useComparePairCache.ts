/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type MutableRefObject } from 'react';
import { useViewerStore } from '@/store';
import { isCurrentFor, type BuiltPair } from './comparePairCache';
import { invalidateAbortableRun } from '../analysisRunCancellation';

/** Explicit native-model ownership (#8042). Invalidate synchronously with the
 * store, before another caller can reuse the cache; results outlive disposal.
 * Invalidating also aborts the in-flight extraction (`active`, A2): a session
 * reset or a pair change used to leave it fingerprinting a pair nobody waits on. */
export function useComparePairCache(epoch: MutableRefObject<number>, active: MutableRefObject<AbortController | null>) {
  const builtRef = useRef<BuiltPair | null>(null);
  useEffect(() => {
    const release = () => {
      const built = builtRef.current;
      builtRef.current = null;
      built?.dispose();
    };
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      const cleared = (previous.compareResult !== null && state.compareResult === null)
        || (previous.compareRunning && !state.compareRunning && !state.compareResult);
      if (cleared || state.compareBaseModelId !== previous.compareBaseModelId
        || state.compareHeadModelId !== previous.compareHeadModelId
        || state.compareKeyProperty !== previous.compareKeyProperty
        || !state.models.has(state.compareBaseModelId ?? '')
        || !state.models.has(state.compareHeadModelId ?? '')) {
        invalidateAbortableRun(epoch, active);
        release();
        if (state.compareRunning) state.setCompareRunning(false);
        return;
      }
      const built = builtRef.current;
      if (built && !isCurrentFor(built, state.compareBaseModelId ?? '', state.compareHeadModelId ?? '',
        state.geometryContentVersion, state.compareKeyProperty)) release();
    });
    return () => {
      unsubscribe();
      invalidateAbortableRun(epoch, active);
      release();
      // This hook owns the panel run; its superseded continuation cannot clear
      // progress once unmounted, so release the UI flag with the native owner.
      const state = useViewerStore.getState();
      if (state.compareRunning) state.setCompareRunning(false);
    };
  }, [epoch, active]);
  return builtRef;
}
