/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport's plain-key camera shortcuts (1–6 preset views, F frame, H home,
 * Z fit all) must ignore keys pressed with Ctrl/Meta/Alt (#5596): Ctrl+Z is
 * undo, Ctrl+F search, Alt+1 opens panel 1 — none of them may move the camera.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useKeyboardControls } from './useKeyboardControls.js';

function Harness(props: { cameraCalls: string[] }) {
  const record = (name: string) => () => { props.cameraCalls.push(name); };
  const rendererRef = useRef<Renderer | null>({
    getCamera: () => ({
      frameBounds: record('frameBounds'),
      zoomExtent: record('zoomExtent'),
      setPresetView: record('setPresetView'),
      pan: () => {},
      moveFirstPerson: () => {},
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
    }),
    requestRender: () => {},
  } as unknown as Renderer);

  useKeyboardControls({
    rendererRef,
    isInitialized: true,
    keyboardHandlersRef: useRef({ handleKeyDown: null, handleKeyUp: null }),
    firstPersonModeRef: useRef(false),
    geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }),
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

describe('useKeyboardControls — camera shortcuts ignore modifier chords (#5596)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.getState().setCameraCallbacks({});
  });

  it('plain Z and 1 still move the camera (control)', () => {
    const cameraCalls: string[] = [];
    // Z is the one Fit All (#5884), registered by Viewport as a camera callback.
    useViewerStore.getState().setCameraCallbacks({ fitAll: () => { cameraCalls.push('fitAll'); } });
    render(<Harness cameraCalls={cameraCalls} />);
    press(window, 'z');
    press(window, '1');
    assert.deepEqual(cameraCalls, ['fitAll', 'setPresetView']);
  });

  it('Ctrl+Z, Meta+Z, Ctrl+F and Alt+1 do not change the camera', () => {
    const cameraCalls: string[] = [];
    render(<Harness cameraCalls={cameraCalls} />);
    press(window, 'z', { ctrlKey: true });
    press(window, 'z', { metaKey: true });
    press(window, 'f', { ctrlKey: true });
    press(window, '1', { altKey: true });
    assert.deepEqual(cameraCalls, []);
  });
});
