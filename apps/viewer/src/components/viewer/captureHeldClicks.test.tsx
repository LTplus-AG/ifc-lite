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
import { mountViewportControls, pointer, tap, click, pencilTap } from '@/test/touch-controls-fixture.js';
import { mousePointer } from '@/test/mouse-controls-fixture';
import { captureViewportFrame, noteLiveFrameSubmitted, registerViewportCapture, viewportPicksAwaitLiveFrame } from '@/lib/viewport-capture';

let initialState: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => { initialState = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  useViewerStore.setState(initialState, true);
});

/** The mounted canvas and a renderer a capture draws for, counting the picks a click or tap places or selects through. */
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
      pickRect: counted(async () => [41, 42]),
      // Not counted: a press's orbit pivot reads it too, and places nothing. A face-pick is asserted on its cut.
      raycastScene: () => ({ intersection: { point: { x: 1, y: 2, z: -2 }, normal: { x: 0, y: 0, z: 1 }, expressId: 7 } }),
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
    /** Send these events to the canvas, then let a pick they started settle. */
    async send(...events: Event[]) {
      await act(async () => { for (const e of events) canvas.dispatchEvent(e); await Promise.resolve(); });
    },
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

  it('a Distance press before the capture, released after it, finishes nothing and keeps its start', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const h = rig('measure');
    await h.send(pointer('pointerdown', 'mouse', 200, 300, 1));
    assert.equal(s().activeMeasurement?.start.x, 2, 'fixture: the press must set the start');
    await h.capture();
    // Dragged past the click slop: its release would finish where it lands.
    await h.send(pointer('pointermove', 'mouse', 500, 300, 1), pointer('pointerup', 'mouse', 500, 300), click(500, 300, 'mouse'));
    assert.equal(s().measurements.length, 0, 'a Distance release finished on the capture\'s frame');
    assert.equal(s().activeMeasurement?.start.x, 2, 'a refused release dropped the pending start');
    h.liveFrame();
    await h.mouseClick(500, 300);
    assert.equal(s().measurements.length, 1, 'the click after the live frame did not finish');
  });

  it('a right-click opens no context menu for what the capture shows, then the next one does', async () => {
    const h = rig('select', 42);
    await h.capture();
    const menu = () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
    await h.send(menu());
    assert.equal(h.count.picks, 0, 'a context-menu pick read the capture\'s clip');
    assert.equal(h.menus.length, 0, 'a context menu opened for an entity on the capture\'s frame');
    h.liveFrame();
    await h.send(menu());
    assert.deepEqual(h.menus.map(m => m.id), [42], 'the right-click after the live frame opened no menu');
  });

  it('a Ctrl-drag rectangle selects nothing through the capture, then the next one selects', async () => {
    const h = rig('select');
    const rectangle = () => [
      mousePointer('pointerdown', 0, 100, 100, { ctrlKey: true }),
      mousePointer('pointermove', 0, 300, 300, { ctrlKey: true }),
      mousePointer('pointerup', 0, 300, 300, { ctrlKey: true }),
    ];
    useViewerStore.getState().setSelectedEntityIds([7]);
    await h.capture();
    await h.send(...rectangle());
    assert.equal(h.count.picks, 0, 'a rectangle pick read the capture\'s clip');
    assert.deepEqual([...s().selectedEntityIds], [7], 'a rectangle replaced the selection with ids on the capture\'s frame');
    h.liveFrame();
    await h.send(...rectangle());
    assert.deepEqual([...s().selectedEntityIds].sort(), [41, 42], 'the rectangle after the live frame selected nothing');
  });

  it('a Polyline double-click whose clicks were refused finishes nothing, then the next one finishes with its point', async () => {
    useViewerStore.setState({ measureMode: 'polyline', polylineMeasurements: [] });
    const h = rig('measure');
    await h.mouseClick(100, 300);
    await h.mouseClick(200, 300);
    assert.equal(s().activePolyline?.points.length, 2, 'fixture: two points must be placed');
    const doubleClick = async (x: number) => {
      await h.mouseClick(x, 300);
      await h.mouseClick(x, 300);
      await h.send(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: 300 }));
    };
    await h.capture();
    await doubleClick(400);
    assert.equal(s().polylineMeasurements.length, 0, 'a refused double-click finished the polyline without its last point');
    assert.equal(s().activePolyline?.points.length, 2, 'a refused double-click changed the polyline');
    h.liveFrame();
    await doubleClick(400);
    assert.equal(s().polylineMeasurements.length, 1, 'the double-click after the live frame did not finish');
    assert.equal(s().polylineMeasurements[0].points.length, 3, 'the finished polyline lost its last point');
  });

  it('an Apple Pencil tap in Select is refused, then the next one selects once', async () => {
    const h = rig('select', 42);
    await h.capture();
    await pencilTap(h.canvas, 200, 300);
    assert.equal(h.count.picks, 0, 'a pen tap picked through the capture\'s clip');
    assert.equal(h.selectionCount(), 0, 'a refused pen tap selected');
    h.liveFrame();
    await pencilTap(h.canvas, 200, 300);
    assert.equal(h.selectionCount(), 1, 'the pen tap after the live frame did not select once');
  });
});
