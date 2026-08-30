/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, SectionPlane, CameraState, ViewerBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';
import { toGlobalIdForRef } from '../../store/globalId.js';

const AXIS_TO_STORE: Record<string, 'down' | 'front' | 'side'> = {
  x: 'side',
  y: 'down',
  z: 'front',
};
const STORE_TO_AXIS: Record<string, 'x' | 'y' | 'z'> = {
  side: 'x',
  down: 'y',
  front: 'z',
};

export function createViewerAdapter(store: StoreApi): ViewerBackendMethods {
  // Tracks colors the SDK itself has applied. `pendingColorUpdates` in the store is a
  // one-shot signal: the geometry-streaming effect flushes it to the renderer and then
  // nulls it out, so it can't be read back later as "what's currently applied". This
  // closure survives that flush, so resetColors(refs) can compute "all SDK colors minus
  // refs" even after the effect has already run.
  let sdkColorOverrides = new Map<number, [number, number, number, number]>();

  return {
    colorize(refs: EntityRef[], color: [number, number, number, number]) {
      const state = store.getState();
      // Merge with existing pending colors (supports multiple colorize calls per script,
      // and survives the effect having already flushed+cleared pendingColorUpdates).
      const existing = state.pendingColorUpdates ?? sdkColorOverrides;
      const colorMap = new Map(existing);
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        colorMap.set(toGlobalIdForRef(state.models, ref), color);
      }
      sdkColorOverrides = colorMap;
      state.setPendingColorUpdates(colorMap);
      return undefined;
    },
    colorizeAll(batches: Array<{ refs: EntityRef[]; color: [number, number, number, number] }>) {
      const state = store.getState();
      // Batch colorize: build the complete color map in a single call.
      // Avoids accumulation issues when React effects fire between calls.
      const batchMap = new Map<number, [number, number, number, number]>();
      for (const batch of batches) {
        for (const ref of batch.refs) {
          if (!getModelForRef(state, ref.modelId)) continue;
          batchMap.set(toGlobalIdForRef(state.models, ref), batch.color);
        }
      }
      sdkColorOverrides = batchMap;
      state.setPendingColorUpdates(batchMap);
      return undefined;
    },
    resetColors(refs?: EntityRef[]) {
      const state = store.getState();
      if (!refs || refs.length === 0) {
        // Set empty map to trigger scene.clearColorOverrides() (null skips the effect)
        sdkColorOverrides = new Map();
        state.setPendingColorUpdates(new Map());
        return undefined;
      }
      // Targeted reset: drop only the given entities from the known override set,
      // re-emitting whatever remains (same "empty map clears everything" contract above —
      // if nothing remains, this naturally clears everything too).
      const existing = state.pendingColorUpdates ?? sdkColorOverrides;
      const colorMap = new Map(existing);
      for (const ref of refs) {
        colorMap.delete(toGlobalIdForRef(state.models, ref));
      }
      sdkColorOverrides = colorMap;
      state.setPendingColorUpdates(colorMap);
      return undefined;
    },
    flyTo() {
      // flyTo requires renderer access — wired via useBimHost
      return undefined;
    },
    setSection(section: SectionPlane | null) {
      const state = store.getState();
      if (section) {
        state.setSectionPlaneAxis?.(AXIS_TO_STORE[section.axis] ?? 'down');
        state.setSectionPlanePosition?.(section.position);
        if (section.flipped !== undefined && state.sectionPlane?.flipped !== section.flipped) {
          state.flipSectionPlane?.();
        }
        if (state.sectionPlane?.enabled !== section.enabled) {
          state.toggleSectionPlane?.();
        }
      } else {
        if (state.sectionPlane?.enabled) {
          state.toggleSectionPlane?.();
        }
      }
      return undefined;
    },
    getSection() {
      const state = store.getState();
      if (!state.sectionPlane?.enabled) return null;
      return {
        axis: STORE_TO_AXIS[state.sectionPlane.axis] ?? 'y',
        position: state.sectionPlane.position,
        enabled: state.sectionPlane.enabled,
        flipped: state.sectionPlane.flipped,
      };
    },
    setCamera(cameraState: Partial<CameraState>) {
      const state = store.getState();
      if (cameraState.mode) {
        state.setProjectionMode?.(cameraState.mode);
      }
      return undefined;
    },
    getCamera() {
      const state = store.getState();
      return { mode: state.projectionMode ?? 'perspective' };
    },
  };
}
