/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useAnimationLoop, type UseAnimationLoopParams } from '@/components/viewer/useAnimationLoop';
import { subscribePlacementBounds } from '@/lib/model-placement/bounds-revision';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';

/** Scheduling boundary only: each held RAF callback is the production hook's
 * callback; queue upload, Renderer, Scene and recovery are never replaced. */
export function retainedStreamAnimation(renderer: Renderer, canvas: HTMLCanvasElement) {
  const savedRaf = globalThis.requestAnimationFrame, savedCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0, invocations = 0, uploads = 0;
  globalThis.requestAnimationFrame = callback => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
  const unsubscribe = subscribePlacementBounds(() => { uploads++; });
  const ref = <T,>(current: T) => ({ current });
  const params: UseAnimationLoopParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    animationFrameRef: ref(null), lastFrameTimeRef: ref(0), mouseIsDraggingRef: ref(false),
    activeToolRef: ref('select'), terrainClipYRef: ref(null), hiddenEntitiesRef: ref(new Set()),
    isolatedEntitiesRef: ref(null), ghostExceptEntitiesRef: ref(null), selectedEntityIdRef: ref(null),
    selectedModelIndexRef: ref(undefined), clearColorRef: ref([0, 0, 0, 1]),
    visualEnhancementRef: ref({ enabled: false }), environmentRef: ref({}), sunShadowsRef: ref(null),
    sectionPlaneRef: ref({ ...useViewerStore.getState().sectionPlane, enabled: false }),
    sectionRangeRef: ref(null), selectedEntityIdsRef: ref(undefined), clashHighlightColorsRef: ref(null),
    coordinateInfoRef: ref(undefined), isInteractingRef: ref(false), lastCameraStateRef: ref(null),
    updateCameraRotationRealtime() {}, calculateScale() {}, updateMeasurementScreenCoords() {},
    hasPendingMeasurements: () => false,
  };
  function Probe() { useAnimationLoop(params); return null; }
  try { render(<Probe />); }
  catch (error) {
    cleanup(); unsubscribe(); globalThis.requestAnimationFrame = savedRaf; globalThis.cancelAnimationFrame = savedCancel;
    throw error;
  }
  return {
    get invocations() { return invocations; }, get uploads() { return uploads; },
    step() {
      const pending = [...callbacks]; callbacks.clear();
      assert.equal(pending.length, 1, 'one actual foreground coordinator callback is scheduled');
      act(() => { for (const [, callback] of pending) { invocations++; callback(performance.now() + invocations * 16); } });
      assert.equal(callbacks.size, 1, 'the original foreground coordinator re-arms after this frame');
    },
    dispose() {
      cleanup(); unsubscribe(); callbacks.clear();
      globalThis.requestAnimationFrame = savedRaf; globalThis.cancelAnimationFrame = savedCancel;
    },
  };
}
