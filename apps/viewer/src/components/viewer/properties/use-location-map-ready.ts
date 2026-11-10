/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

/** Keep initial WebGL setup after scene drain/finalise, then latch readiness. */
export function useLocationMapReady(hasLocation: boolean): boolean {
  const [loading, error, modelId] = useViewerStore(useShallow((s) => [s.loading, s.error, s.activeModelId] as const));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || loading || error || !hasLocation) return;
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const check = () => {
      const state = useViewerStore.getState();
      if (state.loading || state.error || state.activeModelId !== modelId) return;
      const scene = getGlobalRenderer()?.getScene();
      // Finalisation empties fragments before its async rebuild ends. Both
      // guards are required; loading=false alone precedes this whole phase.
      if (state.geometryStreamingActive || state.pendingInstancedShards?.length
        || scene?.hasQueuedMeshes() || scene?.hasStreamingFragments() || scene?.isFinalizeInProgress()) {
        // Ten constant-time checks/sec initially, one/sec after five seconds.
        // Failed finalisation may retain fragments until device recovery; keep
        // waiting without starting WebGL or spinning at the display frame rate.
        timer = setTimeout(check, ++polls < 50 ? 100 : 1000);
        return;
      }
      setReady(true);
    };
    timer = setTimeout(check, 100);
    return () => clearTimeout(timer);
  }, [ready, loading, error, modelId, hasLocation]);
  return ready;
}
