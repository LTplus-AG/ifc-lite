/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { afterSceneSettled } from '@/lib/scene-settled';

/** Keep initial WebGL setup after scene drain/finalise and the frame that draws it, then latch readiness. */
export function useLocationMapReady(hasLocation: boolean): boolean {
  const [loading, error, modelId] = useViewerStore(useShallow((s) => [s.loading, s.error, s.activeModelId] as const));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || loading || error || !hasLocation) return;
    // First check 100 ms after the effect (no work in the task that ran it),
    // then ten constant-time checks/sec, one/sec after five seconds, until
    // the scene has settled and been drawn. Failed finalisation may retain
    // fragments until device recovery; keep waiting without starting WebGL or
    // spinning at the display frame rate. A new load, an error or another
    // model ends the wait (the effect re-runs on those).
    return afterSceneSettled((settled) => { if (settled) setReady(true); }, () => {
      const state = useViewerStore.getState();
      return !state.loading && !state.error && state.activeModelId === modelId;
    }, Infinity, 100);
  }, [ready, loading, error, modelId, hasLocation]);
  return ready;
}
