/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import {
  roomDrawingContextKey,
  roomDrawingRtcContext,
} from '@/lib/collab/room-drawing-symbolic';
import type { OverlayRtcContext } from '@/lib/overlay-parse/rtc-context';

interface DrawingRtcState {
  context: OverlayRtcContext | null;
  key: string | null;
}

/** Subscribe to every publication channel that can settle drawing RTC provenance. */
export function useDrawingRtcContext(store: object | null): DrawingRtcState {
  const { loading, geometryResult, models } = useViewerStore(
    useShallow((state) => ({
      loading: state.loading,
      geometryResult: state.geometryResult,
      models: state.models,
    })),
  );

  return useMemo(() => {
    if (!store) return { context: null, key: null };
    const context = roomDrawingRtcContext(store);
    return { context, key: roomDrawingContextKey(store, context) };
  }, [store, loading, geometryResult, models]);
}
