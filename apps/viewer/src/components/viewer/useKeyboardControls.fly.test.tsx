/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4868 review: in Walk mode, hold W and then press the right button. The
 * keyboard controller already holds W and keeps calling `moveFirstPerson`,
 * while the fly controller (which reads the same key) starts translating the
 * same camera, so the two speeds add up instead of flying at the selected fly
 * speed along the look direction. The keyboard movement loop has to stand
 * down while a flight is live, and pick up again once it ends.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useKeyboardControls, type UseKeyboardControlsParams } from './useKeyboardControls.js';
import { setFlySpeedState } from './flySpeedStore.js';

interface Moves { walk: number; pan: number }

function Harness(props: { tool: string; moves: Moves }) {
  const rendererRef = useRef({
    getCamera: () => ({
      moveFirstPerson: () => { props.moves.walk++; },
      pan: () => { props.moves.pan++; },
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
    }),
    requestRender: () => {},
  } as unknown as UseKeyboardControlsParams['rendererRef']['current']);

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
    activeToolRef: useRef(props.tool),
    sectionPlaneRef: useRef(null as never),
    sectionRangeRef: useRef(null),
    updateCameraRotationRealtime: () => {},
    calculateScale: () => {},
  });
  return null;
}

const frames = () => new Promise((r) => setTimeout(r, 120));
const key = (type: 'keydown' | 'keyup', k: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));

describe('useKeyboardControls while a right-button flight is live (#4868)', () => {
  afterEach(() => {
    setFlySpeedState({ active: false });
    cleanup();
  });

  for (const [tool, k, channel] of [['walk', 'w', 'walk'], ['select', 'ArrowUp', 'pan']] as const) {
    it(`${tool} tool: a held ${k} stops moving the camera while flying, and resumes after`, async () => {
      const moves: Moves = { walk: 0, pan: 0 };
      render(<Harness tool={tool} moves={moves} />);
      key('keydown', k); // held BEFORE the right press, so fly never got to swallow it
      await frames();
      assert.ok(moves[channel] > 0, `precondition: a held ${k} moves the camera`);

      setFlySpeedState({ active: true }); // right button pressed: fly owns the camera
      await frames();
      const during = moves[channel];
      await frames();
      assert.equal(moves[channel], during, 'the keyboard loop must not add its own movement to the flight');

      setFlySpeedState({ active: false }); // right button released, key still held
      await frames();
      assert.ok(moves[channel] > during, 'the still-held key moves again once the flight ends');
      key('keyup', k);
    });
  }
});
