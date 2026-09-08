/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `F` keyboard shortcut ("frame selection") reimplemented framing from
 * scratch instead of calling the shared `cameraCallbacks.frameSelection`
 * (Viewport.tsx) every other entry point uses — the toolbar button, the
 * ribbon, the command palette, search, hierarchy, properties, compare and
 * clash all go through `frameSelection`, which:
 *
 *   - unions the FULL multi-selection set (`selectedEntityIds`), not just the
 *     single primary id (see `SearchInline.wiring.test.tsx` for the same
 *     "multi-select over single" rule elsewhere), and
 *   - resolves a geometry-less assembly (`IfcElementAssembly` et al.) to the
 *     aggregated parts that actually carry geometry (#1133) before giving up.
 *
 * `useKeyboardControls.ts`'s own `f`/`F` handler skipped both: it read only
 * `selectedEntityIdRef.current` and called `getEntityBounds` directly, which
 * returns `null` for an id with no meshes of its own. So pressing F with a
 * multi-selection framed only whichever id happened to be "the" selected one,
 * and pressing F on a geometry-less assembly did nothing at all — while the
 * toolbar's identically-labelled "Frame selection" button worked in both
 * cases. Zero test files existed for this hook before this one.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useKeyboardControls, type UseKeyboardControlsParams } from './useKeyboardControls.js';

let initialState: ReturnType<typeof useViewerStore.getState>;

function Harness(props: { frameCalls: string[]; frameBoundsCalls: number[] }) {
  const rendererRef = useRef<UseKeyboardControlsParams['rendererRef']['current']>({
    // Minimal stub: only the calls the 'f' code path can reach are needed.
    getCamera: () => ({
      frameBounds: () => { props.frameBoundsCalls.push(1); },
      zoomExtent: () => {},
      setPresetView: () => {},
      zoom: () => {},
      pan: () => {},
      moveFirstPerson: () => {},
      setRotation: () => {},
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  useKeyboardControls({
    rendererRef,
    isInitialized: true,
    keyboardHandlersRef: useRef({ handleKeyDown: null, handleKeyUp: null }),
    firstPersonModeRef: useRef(false),
    geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }),
    coordinateInfoRef: useRef(undefined),
    geometryRef: useRef([]),
    selectedEntityIdRef: useRef(1),
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

describe('useKeyboardControls — F frames through the shared frameSelection callback', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  it('pressing F with a registered frameSelection callback calls it, instead of reimplementing bounds locally', () => {
    initialState = useViewerStore.getState();

    const frameCalls: string[] = [];
    const frameBoundsCalls: number[] = [];
    useViewerStore.getState().setCameraCallbacks({
      frameSelection: () => { frameCalls.push('frameSelection'); },
    });
    // A multi-selection is live — frameSelection is the only path that
    // unions it; the old local reimplementation only ever looked at
    // `selectedEntityIdRef.current`.
    useViewerStore.setState({ selectedEntityIds: new Set([1, 2, 3]) } as never);

    render(<Harness frameCalls={frameCalls} frameBoundsCalls={frameBoundsCalls} />);

    press(window, 'f');

    assert.deepEqual(
      frameCalls,
      ['frameSelection'],
      'F must delegate to cameraCallbacks.frameSelection so multi-selection and ' +
      'geometry-less-assembly resolution (#1133) apply the same way the toolbar button does',
    );
    assert.equal(
      frameBoundsCalls.length,
      0,
      'F must not also call camera.frameBounds directly once frameSelection handled it',
    );
  });
});
