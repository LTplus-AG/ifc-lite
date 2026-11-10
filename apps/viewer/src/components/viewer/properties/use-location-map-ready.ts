/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

/** Keep initial WebGL setup after scene drain/finalise, then latch readiness. */
export function useLocationMapReady(hasLocation: boolean): boolean {
  const loading = useViewerStore((s) => s.loading);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || loading || !hasLocation) return;
    let frame = 0;
    const check = () => {
      const state = useViewerStore.getState();
      if (state.loading) return; // a new load owns the next effect
      const scene = getGlobalRenderer()?.getScene();
      // Finalisation empties fragments before its async rebuild ends. Both
      // guards are required; loading=false alone precedes this whole phase.
      if (state.geometryStreamingActive || state.pendingInstancedShards?.length
        || scene?.hasQueuedMeshes() || scene?.hasStreamingFragments() || scene?.isFinalizeInProgress()) {
        frame = requestAnimationFrame(check);
        return;
      }
      setReady(true);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [ready, loading, hasLocation]);
  return ready;
}
