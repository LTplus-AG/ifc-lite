/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CAMERA_CHANGED must report REAL navigation, at a bounded cadence (#2934
 * item 2).
 *
 * The outbound effect used to subscribe to the store's `cameraRotation`,
 * which only `setCameraRotation` writes. Live navigation -- orbit/pan drag
 * (`useMouseControls.ts`), keyboard (`useKeyboardControls.ts`), the ViewCube
 * and the animation loop (`useAnimationLoop.ts`) -- deliberately bypasses
 * store state and calls `updateCameraRotationRealtime` instead, so the
 * effect's dependency never changed and a host watching a live drag heard
 * nothing.
 *
 * These tests drive `updateCameraRotationRealtime` exactly as those call
 * sites do (`updateCameraRotationRealtime(camera.getRotation())`) and observe
 * what reaches `window.parent.postMessage` -- the same instrument
 * `EmbedViewer.test.ts` uses for SECTION_CHANGED.
 *
 * The cadence is asserted from BOTH ends: a silent bridge fails, and so does
 * a per-frame firehose. "At least one event" would pass both defects.
 *
 * Real timers throughout, deliberately: React 19's scheduler stalls under
 * vitest's faked timer surface, so the store-subscription effects would never
 * flush and the test would be measuring the harness. The waits are one or two
 * throttle windows.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedMessageEnvelope } from '@ifc-lite/embed-protocol';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';

vi.mock('@/components/viewer/Viewport', () => ({ Viewport: () => null }));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));
// Stable function identities across renders: EmbedViewer's bridge-init effect
// lists `loadFile`/`addModel` in its dependency array, so a mock that mints
// fresh vi.fn()s per render tears the bridge down and re-initializes it on
// every re-render -- which resets the negotiated parent origin and silently
// withholds every outbound event but READY (`emitToParent`).
const loadFile = vi.fn(async () => {});
const addModel = vi.fn(async () => 'stub-model-id');
const clearAllModels = vi.fn();
const emptyModels = new Map();
vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult: null,
    ifcDataStore: null,
    loadFile,
    loading: false,
    models: emptyModels,
    clearAllModels,
    addModel,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store/index.js');

/** Mirrors CAMERA_EMIT_INTERVAL_MS in useEmbedBridgeEvents.ts. */
const INTERVAL_MS = 100;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let posted: EmbedMessageEnvelope[] = [];

function mount(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  // `emitToParent` withholds every message except READY until a concrete
  // parent origin is known (it refuses to broadcast to '*'), so an inbound
  // handshake is required before ANY outbound event can be observed.
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: EMBED_SOURCE, version: PROTOCOL_VERSION, type: 'INIT' },
        origin: 'https://parent.example',
        source: window.parent,
      }),
    );
  });
}

/** The exact call every live-navigation site makes. */
function drag(azimuth: number, elevation: number): void {
  act(() => {
    useViewerStore.getState().updateCameraRotationRealtime({ azimuth, elevation });
  });
}

/** Let the throttle window elapse and any trailing flush land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS + 20));
  });
}

function cameraPayloads(): unknown[] {
  return posted.filter((m) => m.type === 'CAMERA_CHANGED').map((m) => m.data);
}

beforeEach(() => {
  posted = [];
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (msg: EmbedMessageEnvelope) => posted.push(msg) },
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.getState().setCameraRotation({ azimuth: 0, elevation: 0 });
});

describe('CAMERA_CHANGED reports live navigation', () => {
  it('emits while the user is dragging the camera', async () => {
    mount();
    await settle();
    posted.length = 0;

    drag(10, 20);
    await settle();

    expect(cameraPayloads()).toContainEqual({ azimuth: 10, elevation: 20 });
  });

  it('emits for a programmatic setCameraRotation (control)', async () => {
    mount();
    await settle();
    posted.length = 0;

    act(() => {
      useViewerStore.getState().setCameraRotation({ azimuth: 33, elevation: 44 });
    });
    await settle();

    expect(cameraPayloads()).toContainEqual({ azimuth: 33, elevation: 44 });
  });

  it('throttles a per-frame drag to the leading pose plus the settled pose', async () => {
    mount();
    await settle();
    posted.length = 0;

    // 30 animation frames back to back: what a real orbit drag produces
    // inside a single throttle window. An unthrottled emitter posts 30.
    for (let frame = 1; frame <= 30; frame += 1) {
      drag(frame, frame * 2);
    }
    // Gesture ends; let the trailing flush land.
    await settle();

    const payloads = cameraPayloads();
    // One leading emit, then one trailing emit per elapsed window. Anything
    // approaching 30 is a firehose; fewer than 2 means the settled pose was
    // dropped rather than deferred.
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.length).toBeLessThanOrEqual(3);
    // The pose the camera SETTLED on must be the last thing the host hears --
    // the old throttle dropped in-window updates instead of deferring them,
    // so the final frame of a gesture was the one most likely to be lost.
    expect(payloads.at(-1)).toEqual({ azimuth: 30, elevation: 60 });
  });

  it('does not re-emit a pose that returns to the last-emitted value mid-window', async () => {
    mount();
    await settle();
    posted.length = 0;

    // {5,5} emits on the leading edge; the next two frames land INSIDE that
    // throttle window, so neither is sent directly -- {6,6} is queued and then
    // overwritten by {5,5}, the pose the camera came back to. An orbit drag
    // nudged off its resting pose and released onto it does this, as does a
    // ViewCube snap that overshoots by a frame.
    //
    // `report` compares the incoming pose against the QUEUED one ({6,6}), so
    // it sees news; only the flush is in a position to notice that what it is
    // about to send is what the host already has, and it never looked.
    drag(5, 5);
    drag(6, 6);
    drag(5, 5);
    await settle();

    // The contract is "never two events for the same pose". {6,6} never
    // reached the host, so a trailing {5,5} would be the same pose twice in a
    // row with nothing in between.
    expect(cameraPayloads()).toEqual([{ azimuth: 5, elevation: 5 }]);
  });

  it('stays silent while the camera is idle (the animation loop re-reports an unchanged pose)', async () => {
    mount();
    await settle();
    drag(7, 8);
    await settle();
    posted.length = 0;

    // useAnimationLoop.ts re-reports the current rotation on a timer even when
    // nothing moved. An unchanged pose is not a change.
    for (let tick = 0; tick < 4; tick += 1) {
      drag(7, 8);
      await settle();
    }

    expect(cameraPayloads()).toEqual([]);
  });
});
