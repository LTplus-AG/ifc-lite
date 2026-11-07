/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9137: a capture (IDS/BCF viewpoint export) draws its own frame, with the
 * section cleared, and until the live loop draws again the pickers mirror
 * that frame's clip (#9002). A click or a tap in that window would place a
 * point, or select, on geometry the live section hides: one the user never
 * saw. It is refused, and the live frame asked for, so the next click picks
 * the view on screen. The hover side is #9031 (measurePointMode.capture.test.tsx).
 *
 * The real `useMouseControls` and `useTouchControls` on one canvas, and the
 * real capture queue; the loop's submitted frame is `noteLiveFrameSubmitted`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { mountViewportControls, pointer, tap, click } from '@/test/touch-controls-fixture.js';
import { captureViewportFrame, noteLiveFrameSubmitted, registerViewportCapture, viewportPicksAwaitLiveFrame } from '@/lib/viewport-capture';

let initialState: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => { initialState = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  useViewerStore.setState(initialState, true);
});

/** The mounted canvas and a renderer a capture draws for, counting every pick it is asked for. */
function rig(tool: string, pickedId: number | null = null) {
  useViewerStore.setState({
    activeTool: tool, activeMeasurement: null, measurements: [], activePolyline: null,
    activeAngle: null, activeRadius: null, measurePointLast: null,
  });
  const count = { picks: 0, renders: 0 };
  const planes: string[] = [];
  const counted = <A extends unknown[], R>(f: (...args: A) => R) => (...args: A) => { count.picks++; return f(...args); };
  const controls = mountViewportControls(tool, pickedId, {
    renderer: {
      requestRender: () => { count.renders++; },
      renderWithResult: () => true,
      getGPUDevice: () => null,
      pick: counted(async () => pickedId === null ? null : { expressId: pickedId }),
      raycastScene: counted(() => ({ intersection: { point: { x: 1, y: 2, z: -2 }, normal: { x: 0, y: 0, z: 1 }, expressId: 7 } })),
      raycastSceneMagnetic: counted((x: number) => ({
        intersection: { point: { x: x / 100, y: 0, z: 0 } }, snapTarget: null,
        edgeLock: { shouldRelease: false, shouldLock: false, edge: null },
      })),
    },
    mouse: { sectionPickModeRef: { current: tool === 'section' }, setSectionPlaneFromFace: (_n, point) => { planes.push(point.join(',')); } },
  });
  const { canvas, renderer } = controls;
  const unregister = registerViewportCapture(renderer, canvas, () => ({}));
  afterEachDispose.push(unregister);
  return {
    ...controls, count, planes,
    /** A capture ran to completion: the pickers mirror its clip until the loop draws again. */
    async capture() {
      assert.equal(await captureViewportFrame(renderer, { read: () => 'pixels' }), 'pixels', 'fixture: the capture must complete');
      assert.equal(viewportPicksAwaitLiveFrame(renderer), true, 'fixture: the pickers must wait on the live frame');
    },
    liveFrame: () => noteLiveFrameSubmitted(renderer as Renderer),
    /** A mouse click as a browser sends it: press, release, click. */
    async mouseClick(x: number, y: number) {
      await act(async () => {
        canvas.dispatchEvent(pointer('pointerdown', 'mouse', x, y, 1));
        canvas.dispatchEvent(pointer('pointerup', 'mouse', x, y));
        canvas.dispatchEvent(click(x, y, 'mouse'));
        await Promise.resolve();
      });
    },
  };
}
const afterEachDispose: Array<() => void> = [];
afterEach(() => { while (afterEachDispose.length) afterEachDispose.pop()!(); });

const s = () => useViewerStore.getState();

describe('a click or tap just after a capture is refused, and the next one picks the live view (#9137)', () => {
  const placed: Record<string, () => number> = {
    point: () => (s().measurePointLast ? 1 : 0),
    polyline: () => s().activePolyline?.points.length ?? 0,
    radius: () => s().activeRadius?.points.length ?? 0,
    angle: () => (s().activeAngle ? 1 : 0),
  };
  for (const mode of Object.keys(placed)) {
    it(`a mouse click in Measure ${mode}`, async () => {
      useViewerStore.setState({ measureMode: mode as 'point' });
      const h = rig('measure');
      await h.capture();
      const renders = h.count.renders;
      await h.mouseClick(200, 300);
      assert.equal(h.count.picks, 0, `a ${mode} click picked through the capture's clip`);
      assert.equal(placed[mode](), 0, `a ${mode} click placed a point on the capture's frame`);
      assert.ok(h.count.renders > renders, 'a refused click left an idle loop with no live frame to draw');
      h.liveFrame();
      await h.mouseClick(200, 300);
      assert.ok(h.count.picks > 0, `a ${mode} click after the live frame did not pick`);
      assert.equal(placed[mode](), 1, `a ${mode} click after the live frame placed nothing`);
    });
  }

  it('a Distance first click sets no start, and a second click leaves the start pending', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const h = rig('measure');
    await h.capture();
    await h.mouseClick(200, 300);
    assert.equal(h.count.picks, 0, 'a Distance press or release picked through the capture\'s clip');
    assert.equal(s().activeMeasurement, null, 'a Distance click set a start on the capture\'s frame');
    h.liveFrame();
    await h.mouseClick(200, 300);
    assert.equal(s().activeMeasurement?.start.x, 2, 'the click after the live frame set no start');
    await h.capture();
    const picks = h.count.picks;
    await h.mouseClick(500, 300);
    assert.equal(h.count.picks, picks, 'a Distance release picked through the capture\'s clip');
    assert.equal(s().measurements.length, 0, 'a Distance click finished on the capture\'s frame');
    assert.equal(s().activeMeasurement?.start.x, 2, 'a refused second click dropped the pending start');
    h.liveFrame();
    await h.mouseClick(500, 300);
    assert.equal(s().measurements.length, 1, 'the second click after the live frame did not finish');
    assert.ok(Math.abs(s().measurements[0].distance - 3) < 1e-9, `distance ${s().measurements[0].distance}, expected 3`);
  });

  it('a Select click selects nothing, then the next click selects', async () => {
    const h = rig('select', 42);
    await h.capture();
    await h.mouseClick(200, 300);
    assert.equal(h.count.picks, 0, 'a Select click picked through the capture\'s clip');
    assert.equal(h.selectionCount(), 0, 'a Select click selected on the capture\'s frame');
    h.liveFrame();
    await h.mouseClick(200, 300);
    assert.equal(h.selectionCount(), 1, 'the click after the live frame did not select');
  });

  it('a Section face-pick click places no cut through a face the capture shows', async () => {
    const h = rig('section');
    await h.capture();
    await h.mouseClick(200, 300);
    assert.deepEqual(h.planes, [], 'a face-pick click picked through the capture\'s clip');
    h.liveFrame();
    await h.mouseClick(200, 300);
    assert.deepEqual(h.planes, ['1,2,-2'], 'the click after the live frame placed no cut');
  });

  it('a finger tap in Select, and its compatibility click, select nothing; the next tap selects once', async () => {
    const h = rig('select', 42);
    await h.capture();
    const renders = h.count.renders;
    await tap(h.canvas, 200, 300);
    // An engine whose compatibility click is no PointerEvent, after the live frame landed: still the refused tap's.
    h.liveFrame();
    await act(async () => { h.canvas.dispatchEvent(click(200, 300, null)); await Promise.resolve(); });
    assert.equal(h.count.picks, 0, 'a tap, or its compatibility click, picked through the capture\'s clip');
    assert.equal(h.selectionCount(), 0, 'a refused tap selected');
    assert.ok(h.count.renders > renders, 'a refused tap asked for no live frame');
    await tap(h.canvas, 200, 300);
    assert.equal(h.selectionCount(), 1, 'the tap after the live frame did not select');
  });

  it('a finger tap in Measure Point places nothing, then the next tap places the point', async () => {
    useViewerStore.setState({ measureMode: 'point' });
    const h = rig('measure');
    await h.capture();
    await tap(h.canvas, 200, 300);
    assert.equal(h.count.picks, 0, 'a Point tap picked through the capture\'s clip');
    assert.equal(s().measurePointLast, null, 'a Point tap placed a point on the capture\'s frame');
    h.liveFrame();
    await tap(h.canvas, 200, 300);
    assert.equal(s().measurePointLast?.x, 2, 'the tap after the live frame placed no point');
  });
});
