/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RtcFrame } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';

export type OverlayRtcContext =
  | { mode: 'pending' }
  | { mode: 'standalone'; key: 'standalone'; frame: undefined }
  | { mode: 'explicit'; key: string; frame: RtcFrame };

function numberKey(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

function explicit(frame: RtcFrame): OverlayRtcContext {
  const snapshot = { ...frame };
  return {
    mode: 'explicit',
    key: `explicit:${numberKey(snapshot.x)},${numberKey(snapshot.y)},${numberKey(snapshot.z)},${snapshot.needsShift}`,
    frame: snapshot,
  };
}

/** Resolve RTC provenance for the model that owns `store`, never a sibling. */
export function overlayRtcContextFor(store: object): OverlayRtcContext {
  const state = useViewerStore.getState();
  for (const model of state.models.values()) {
    if (model.ifcDataStore !== store) continue;
    const frame = model.geometryResult?.coordinateInfo?.wasmRtcFrame;
    if (frame) return explicit(frame);
    if (model.loadState && model.loadState !== 'complete' && model.loadState !== 'error') {
      return { mode: 'pending' };
    }
    return { mode: 'standalone', key: 'standalone', frame: undefined };
  }

  if (state.ifcDataStore === store) {
    const frame = state.geometryResult?.coordinateInfo?.wasmRtcFrame;
    if (frame) return explicit(frame);
    if (state.loading) return { mode: 'pending' };
  }
  return { mode: 'standalone', key: 'standalone', frame: undefined };
}
