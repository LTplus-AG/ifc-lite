/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8866: Polyline, Angle and Radius drop a vertex that snapping pulls onto the
 * previous one. The same shape #8788 fixed for Distance's second point: a press
 * clearly away from the previous vertex, but within the 60px snap radius of it,
 * takes the exact surface hit instead of being swallowed. A double-click, a
 * double-tap and a retap on the previous vertex are still no new vertex.
 *
 * Mounts the real `useMouseControls`, so clicks and taps go through the
 * production paths (`handleSelectionClick` and `handleMeasureTap`) with the
 * fixture's real camera. The snap stub is keyed to where that camera shows the
 * corner, as the renderer's screen-space snap radius is.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore, type MeasurePoint } from '@/store';
import { cleanupMouseControls, mountMouseControls, mousePointer } from '@/test/mouse-controls-fixture.js';
import type { UseMouseControlsParams } from './useMouseControls.js';
import { handleMeasureTap } from './touchRouting.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

const s = () => useViewerStore.getState();
const initial = useViewerStore.getState();
const edgeLock = { shouldRelease: false, shouldLock: false, edge: null };
const CORNER = { x: 2, y: 0, z: 0 };
/** The exact surface under the pointer: canvas x/100, (300 - y)/100. */
const surfaceAt = (x: number, y: number) => ({ x: x / 100, y: (300 - y) / 100, z: 0 });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const sameWorld = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z);

/** Mount the real mouse controls with a renderer that snaps anything within 60px of where the corner shows onto it. */
function mountSnapping() {
  const rig = mountMouseControls({
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: true },
    edgeLockStateRef: { get current() { return s().edgeLockState; }, set current(_v) { /* store-owned */ } },
    updateMeasurementScreenCoords: (project) => s().updateMeasurementScreenCoords(project),
  });
  const { params, canvas } = rig;
  const ctx = {
    ...params, canvas, renderer: params.rendererRef.current, camera: params.rendererRef.current!.getCamera(),
    mouseState: params.mouseStateRef.current,
  } as unknown as MouseHandlerContext;
  const shown = projectToCssScreen(ctx.camera, canvas, CORNER)!;
  Object.assign(params.rendererRef.current!, {
    raycastSceneMagnetic: (x: number, y: number) => Math.hypot(x - shown.x, y - shown.y) < 60
      ? { intersection: { point: CORNER }, snapTarget: null, edgeLock }
      : { intersection: { point: surfaceAt(x, y) }, snapTarget: null, edgeLock },
    raycastScene: (x: number, y: number) => ({ intersection: { point: surfaceAt(x, y), normal: { x: 0, y: 0, z: 1 } } }),
  });
  return { ...rig, ctx, shown };
}

/** A mouse click as the browser delivers it: press, release, click. */
function click(canvas: HTMLCanvasElement, x: number, y: number): void {
  act(() => {
    canvas.dispatchEvent(mousePointer('pointerdown', 0, x, y, { pointerType: 'mouse' }));
    canvas.dispatchEvent(mousePointer('pointerup', 0, x, y, { pointerType: 'mouse' }));
    const e = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(e, { clientX: { value: x }, clientY: { value: y }, pointerType: { value: 'mouse' } });
    canvas.dispatchEvent(e);
  });
}

/** A physical double-click: two clicks then the browser's dblclick. */
function doubleClick(canvas: HTMLCanvasElement, x: number, y: number): void {
  click(canvas, x, y);
  click(canvas, x, y);
  act(() => {
    const e = new MouseEvent('dblclick', { button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(e, { clientX: { value: x }, clientY: { value: y } });
    canvas.dispatchEvent(e);
  });
}

/** Vertices with consecutive duplicates collapsed: Polyline and Radius keep a double-click's twin until the finish drops it. */
const distinctOf = (vertices: MeasurePoint[]) => vertices.filter((v, i) => i === 0 || !sameWorld(v, vertices[i - 1]));

type Rig = ReturnType<typeof mountSnapping>;
type Press = (rig: Rig, x: number, y: number) => void;
const tap: Press = (rig, x, y) => act(() => handleMeasureTap(rig.ctx, x, y));
const mouse: Press = (rig, x, y) => click(rig.canvas, x, y);

/** The placed vertices of the mode under test, in order. */
type Mode = { name: 'polyline' | 'angle' | 'radius'; vertices: () => MeasurePoint[] };
const MODES: Mode[] = [
  { name: 'polyline', vertices: () => s().activePolyline?.points ?? [] },
  { name: 'angle', vertices: () => (s().activeAngle?.picks ?? []).map((p) => p.point) },
  { name: 'radius', vertices: () => s().activeRadius?.points ?? [] },
];

beforeEach(() => {
  useViewerStore.setState(initial, true);
  s().setActiveTool('measure');
});

afterEach(() => {
  cleanupMouseControls();
  useViewerStore.setState(initial, true);
});

for (const mode of MODES) {
  for (const [input, press] of [['tap', tap], ['click', mouse]] as const) {
    describe(`${mode.name}: a snap never swallows a ${input} placed away from the previous vertex (#8866)`, () => {
      beforeEach(() => {
        s().setMeasureMode(mode.name);
        if (mode.name === 'angle') s().setAngleKind('points');
      });

      it(`a ${input} 60px from the last one that snaps onto its vertex adds the surface point ${input}ped`, () => {
        const rig = mountSnapping();
        const { shown } = rig;
        press(rig, shown.x + 30, shown.y);
        assert.equal(mode.vertices().length, 1, 'the first press places a vertex');
        assert.ok(sameWorld(mode.vertices()[0], CORNER), 'the first press snaps to the corner 30px away');
        press(rig, shown.x - 30, shown.y);
        assert.equal(mode.vertices().length, 2, 'BUG: the snap pulled the second press onto the previous vertex and it was dropped');
        const added = mode.vertices()[1];
        assert.ok(!sameWorld(added, CORNER), 'BUG: the second vertex is the previous one again, a zero-length segment');
        assert.ok(sameWorld(added, surfaceAt(shown.x - 30, shown.y)), `the second vertex is the surface under the press, got ${added.x},${added.y}`);
      });

      it(`a camera frame between the ${input}s (the vertex rebuilt by its reprojection) keeps the fallback`, () => {
        const rig = mountSnapping();
        const { shown, ctx, canvas } = rig;
        press(rig, shown.x + 30, shown.y);
        const before = mode.vertices()[0];
        act(() => s().updateMeasurementScreenCoords((p) => {
          const at = projectToCssScreen(ctx.camera, canvas, p);
          return at ? { x: at.x + 0.5, y: at.y } : null;
        }));
        assert.notEqual(mode.vertices()[0], before, 'the reprojection rebuilds the vertex object');
        press(rig, shown.x - 30, shown.y);
        assert.equal(mode.vertices().length, 2, 'BUG: a reprojected vertex lost its press and the next one was dropped');
        assert.ok(!sameWorld(mode.vertices()[1], CORNER), 'the second vertex is not the corner again');
      });

      it(`a double-${input} near the vertex both ${input}s snap to adds it once`, () => {
        const rig = mountSnapping();
        const { shown } = rig;
        press(rig, shown.x - 30, shown.y + 100); // outside the snap radius: plain surface
        press(rig, shown.x + 30, shown.y);
        press(rig, shown.x + 31, shown.y + 1);
        const distinct = distinctOf(mode.vertices());
        assert.equal(distinct.length, 2, 'BUG: the second press of a double-press became a new vertex from the surface');
        assert.ok(sameWorld(distinct[1], CORNER), 'the double-press placed the corner it snapped to');
      });

      it(`a double-${input} away from the previous vertex that both ${input}s snap onto adds one surface point`, () => {
        const rig = mountSnapping();
        const { shown } = rig;
        press(rig, shown.x + 30, shown.y);
        press(rig, shown.x - 30, shown.y);
        press(rig, shown.x - 30, shown.y);
        const distinct = distinctOf(mode.vertices());
        assert.equal(distinct.length, 2, `BUG: the double-press left ${distinct.length} vertices, expected the corner and one surface point`);
        assert.ok(sameWorld(distinct[1], surfaceAt(shown.x - 30, shown.y)), 'the double-press placed the surface point under it');
        assert.ok(!mode.vertices().slice(1).some((v) => sameWorld(v, CORNER)), 'BUG: the second press snapped back onto the earlier corner');
      });

      it(`a double-${input} with the camera drifting a few pixels between the ${input}s adds it once`, () => {
        const rig = mountSnapping();
        const { shown, ctx, canvas } = rig;
        press(rig, shown.x - 30, shown.y + 100);
        press(rig, shown.x + 30, shown.y);
        const camera = ctx.camera as unknown as { getPosition(): { x: number; y: number; z: number }; getTarget(): { x: number; y: number; z: number }; setPosition(x: number, y: number, z: number): void; setTarget(x: number, y: number, z: number): void };
        const pos = camera.getPosition(); const target = camera.getTarget();
        camera.setPosition(pos.x - 0.04, pos.y, pos.z); camera.setTarget(target.x - 0.04, target.y, target.z);
        act(() => s().updateMeasurementScreenCoords((p) => projectToCssScreen(ctx.camera, canvas, p)));
        const after = projectToCssScreen(ctx.camera, canvas, CORNER)!;
        const drift = Math.hypot(after.x - shown.x, after.y - shown.y);
        assert.ok(drift > 2 && drift < 8, `the vertex drifted ${drift}px; the test needs a few pixels`);
        press(rig, shown.x + 31, shown.y);
        assert.equal(distinctOf(mode.vertices()).length, 2, 'BUG: a small camera drift let the second press of a double-press add a vertex');
      });

      it(`a ${input} 5px from a plain surface vertex is still a new vertex`, () => {
        const rig = mountSnapping();
        const { shown } = rig;
        press(rig, shown.x - 30, shown.y + 100);
        press(rig, shown.x - 25, shown.y + 100);
        assert.equal(distinctOf(mode.vertices()).length, 2, 'BUG: a deliberate pick 5px away was taken for a double-press');
      });

      it(`a ${input} on the previous vertex as it shows is still a retap, not a new point`, () => {
        const rig = mountSnapping();
        const { shown } = rig;
        press(rig, shown.x + 30, shown.y);
        press(rig, shown.x, shown.y);
        assert.equal(distinctOf(mode.vertices()).length, 1, 'BUG: a retap on the previous vertex became a new vertex');
      });
    });
  }
}

describe('Polyline and Radius still finish on a double-click (#8866)', () => {
  for (const name of ['polyline', 'radius'] as const) {
    it(`${name}: a double-click on the last vertex finishes without a duplicate`, () => {
      s().setMeasureMode(name);
      const rig = mountSnapping();
      const { shown, canvas } = rig;
      click(canvas, shown.x + 30, shown.y); // snaps to the corner
      click(canvas, shown.x - 30, shown.y + 100); // well away from the corner: plain surface
      doubleClick(canvas, shown.x - 30, shown.y - 100);
      const finished = name === 'polyline' ? s().polylineMeasurements : s().radiusMeasurements;
      assert.equal(name === 'polyline' ? s().activePolyline : s().activeRadius, null, 'the double-click finished the sequence');
      assert.equal(finished.length, 1, 'one measurement recorded');
      assert.equal(finished[0].points.length, 3, 'the double-click added its point once');
    });

    it(`${name}: a double-click away from the last vertex that snaps onto it finishes on the surface point`, () => {
      s().setMeasureMode(name);
      const rig = mountSnapping();
      const { shown, canvas } = rig;
      click(canvas, shown.x - 30, shown.y + 100);
      click(canvas, shown.x + 30, shown.y); // snaps to the corner
      doubleClick(canvas, shown.x - 30, shown.y); // both clicks snap onto the corner
      const finished = name === 'polyline' ? s().polylineMeasurements : s().radiusMeasurements;
      assert.equal(finished.length, 1, 'one measurement recorded');
      assert.equal(finished[0].points.length, 3, `BUG: the double-click left ${finished[0].points.length} vertices, expected 3`);
      assert.ok(sameWorld(finished[0].points[2], surfaceAt(shown.x - 30, shown.y)), 'the double-click finished on the surface point under it');
    });

    it(`${name}: a double-click on a vertex both clicks snap to finishes without a stray surface point`, () => {
      s().setMeasureMode(name);
      const rig = mountSnapping();
      const { shown, canvas } = rig;
      click(canvas, shown.x - 30, shown.y + 100);
      click(canvas, shown.x - 30, shown.y - 100);
      doubleClick(canvas, shown.x + 30, shown.y); // both clicks snap to the corner
      const finished = name === 'polyline' ? s().polylineMeasurements : s().radiusMeasurements;
      assert.equal(finished.length, 1, 'one measurement recorded');
      assert.equal(finished[0].points.length, 3, 'BUG: the double-click left two vertices');
      assert.ok(sameWorld(finished[0].points[2], CORNER), 'the double-click placed the snapped corner');
    });
  }
});
