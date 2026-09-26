/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5884: Z (and F with nothing selected) is Fit All, and Fit All frames what
 * is visible. The shortcut used to call `camera.zoomExtent` on the load-time
 * bounds cache itself, so it kept framing hidden, isolated-away and
 * hidden-model geometry even once the toolbar's Fit All did not. It now goes
 * through the one `cameraCallbacks.fitAll`.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useKeyboardControls, type UseKeyboardControlsParams } from './useKeyboardControls.js';

function Harness(props: { zoomExtentCalls: number[] }) {
  const rendererRef = useRef({
    // Minimal stub: only the calls the Z / F code paths can reach.
    getCamera: () => ({
      frameBounds: () => {},
      zoomExtent: () => { props.zoomExtentCalls.push(1); },
      setPresetView: () => {},
      zoom: () => {},
      pan: () => {},
      moveFirstPerson: () => {},
      setRotation: () => {},
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
    }),
  } as unknown as UseKeyboardControlsParams['rendererRef']['current']);

  useKeyboardControls({
    rendererRef,
    isInitialized: true,
    keyboardHandlersRef: useRef({ handleKeyDown: null, handleKeyUp: null }),
    firstPersonModeRef: useRef(false),
    geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 1000, y: 10, z: 10 } }),
    coordinateInfoRef: useRef(undefined),
    geometryRef: useRef([]),
    selectedEntityIdRef: useRef(null),
    hiddenEntitiesRef: useRef(new Set()),
    isolatedEntitiesRef: useRef(null),
    selectedModelIndexRef: useRef(undefined),
    clearColorRef: useRef([0, 0, 0, 1]),
    activeToolRef: useRef('select'),
    sectionPlaneRef: useRef(null as never),
    sectionRangeRef: useRef(null),
    updateCameraRotationRealtime: () => {},
    calculateScale: () => {},
  });
  return null;
}

describe('useKeyboardControls: Z and F-without-selection are the one Fit All (#5884)', () => {
  let initialState: ReturnType<typeof useViewerStore.getState>;
  beforeEach(() => { initialState = useViewerStore.getState(); });
  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  for (const key of ['z', 'f']) {
    it(`${key.toUpperCase()} calls cameraCallbacks.fitAll, not zoomExtent on the load-time bounds`, () => {
      const fitAllCalls: number[] = [];
      const zoomExtentCalls: number[] = [];
      useViewerStore.getState().setCameraCallbacks({ fitAll: () => { fitAllCalls.push(1); } });
      useViewerStore.setState({ selectedEntityIds: new Set<number>() });

      render(<Harness zoomExtentCalls={zoomExtentCalls} />);
      press(window, key);

      assert.equal(fitAllCalls.length, 1, 'the shortcut runs the shared Fit All, which frames the visible set');
      assert.equal(zoomExtentCalls.length, 0, 'it does not also frame the whole load-time extent itself');
    });
  }
});
