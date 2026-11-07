/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The guards between a touch gesture and the mouse side's events:
 * - #9091: a tap may drift by the tap slop, so its compatibility click,
 *   which lands where the finger lifted, is dropped within that same slop.
 * - #9087: a mouse or trackpad press near a touch long press means the
 *   context menu after it is genuine, as it closes a Pencil lift's click
 *   window (#9043).
 * - #9122: only the fingers on the canvas make a canvas gesture; a thumb
 *   resting on a side panel neither keeps it multi-touch nor keeps its drag.
 *
 * Mounts the real `useMouseControls` and `useTouchControls` on one canvas.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Camera } from '@ifc-lite/renderer';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import {
  mountViewportControls as rig, pointer, touchEvent, tap, pointerDrag, pos, settle, click,
} from '@/test/touch-controls-fixture.js';

afterEach(() => {
  mock.timers.reset();
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  useViewerStore.setState({ pointerInput: 'mouse' });
});

const viewDirection = (camera: Camera) => {
  const p = camera.getPosition(), t = camera.getTarget();
  const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
  return [(t.x - p.x) / d, (t.y - p.y) / d, (t.z - p.z) / d].map((v) => v.toFixed(9)).join(',');
};

const mouseEvent = (type: string, x: number, y: number, button = 0, pointerType?: string) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  if (pointerType) Object.defineProperty(e, 'pointerType', { value: pointerType });
  return e;
};

/** A one-finger tap at (x, y) that drifts by (dx, dy) before it lifts, as a finger does. */
async function driftTap(canvas: HTMLCanvasElement, x: number, y: number, dx: number, dy: number) {
  await act(async () => {
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x, y]]));
    canvas.dispatchEvent(touchEvent('touchmove', canvas, [[x + dx, y + dy]]));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    await settle();
  });
}

/** A trackpad right-click: the browser's contextmenu has no pointerType (Safari, iPadOS). */
async function trackpadRightClick(canvas: HTMLCanvasElement, x: number, y: number) {
  await act(async () => {
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', x, y, 2, 2));
    canvas.dispatchEvent(mouseEvent('contextmenu', x, y, 2));
    canvas.dispatchEvent(pointer('pointerup', 'mouse', x, y, 0, 2));
    await settle();
  });
}

describe('a tap\'s compatibility click is dropped within the tap slop (#9091)', () => {
  function sectionRig() {
    const planes: string[] = [];
    const sectionPickModeRef = { current: true };
    const hit = { intersection: { point: { x: 1, y: 2, z: -2 }, normal: { x: 0, y: 0, z: -1 }, expressId: 7, meshIndex: 0, triangleIndex: 0 } };
    const controls = rig('section', 42, {
      renderer: { raycastScene: () => hit },
      mouse: {
        sectionPickModeRef,
        setSectionPlaneFromFace: (normal, point) => { planes.push(JSON.stringify({ normal, point })); },
        setSectionPickMode: (enabled) => { sectionPickModeRef.current = enabled; },
      },
    });
    return { ...controls, planes };
  }

  it('Section face-pick: a tap that drifts 8 px places the cut once, not again from its click at the lift', async () => {
    const { canvas, planes } = sectionRig();
    await driftTap(canvas, 300, 200, 8, 0);
    assert.equal(planes.length, 1, 'the drifting tap did not place the cut');
    await act(async () => { canvas.dispatchEvent(click(308, 200, null)); await settle(); });
    assert.equal(planes.length, 1, `BUG: the tap's compatibility click placed the cut a second time (${planes.length} cuts)`);
  });

  it('Select: a tap that drifts diagonally to the slop selects once', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await driftTap(canvas, 200, 300, 10, -10);
    assert.equal(selectionCount(), 1, 'the drifting tap did not select');
    await act(async () => { canvas.dispatchEvent(click(210, 290, null)); await settle(); });
    assert.equal(selectionCount(), 1, `BUG: the tap's compatibility click selected again (${selectionCount()} selections)`);
  });

  it('a trackpad press where a drifting tap lifted closes its window: that click selects', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await driftTap(canvas, 200, 300, 8, 0);
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'mouse', 208, 300));
      canvas.dispatchEvent(pointer('pointerup', 'mouse', 208, 300));
      canvas.dispatchEvent(click(208, 300, null));
      await settle();
    });
    assert.equal(selectionCount(), 2, `BUG: the trackpad click at the tap's lift was dropped (${selectionCount()} selections)`);
  });

  it('an untyped click beyond the slop after a tap is not the tap\'s (control)', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await tap(canvas, 200, 300);
    await act(settle);
    await act(async () => { canvas.dispatchEvent(click(212, 300, null)); await settle(); });
    assert.equal(selectionCount(), 2);
  });
});

describe('a mouse or trackpad press near a touch long press keeps its context menu (#9087)', () => {
  it('a trackpad right-click next to a finger still held opens the viewer menu', async () => {
    const { canvas, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await trackpadRightClick(canvas, 210, 300);
    assert.equal(menus.length, 1, `BUG: the trackpad right-click next to a held finger opened ${menus.length} menus`);
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
  });

  it('a trackpad right-click within a second of a long press, at its spot, opens the viewer menu', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
    assert.equal(menus.length, 1, 'the long press opened its menu');
    mock.timers.reset();
    await trackpadRightClick(canvas, 205, 300);
    assert.equal(menus.length, 2, `BUG: the trackpad right-click after a long press opened ${menus.length - 1} menus`);
  });

  it('a Pencil long press, then a trackpad right-click at its spot, opens the viewer menu again', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]], 'stylus'));
      mock.timers.tick(1);
    });
    await act(async () => { mock.timers.tick(600); await Promise.resolve(); });
    act(() => {
      canvas.dispatchEvent(pointer('pointerup', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    mock.timers.reset();
    await trackpadRightClick(canvas, 200, 300);
    assert.equal(menus.length, 2, `BUG: a Pencil long press then a trackpad right-click opened ${menus.length} menus`);
  });

  it('the native menu of the touch itself stays suppressed, before and after a trackpad press', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    assert.equal(canvas.dispatchEvent(mouseEvent('contextmenu', 200, 300)), false, 'an untyped native menu during the hold was shown');
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 'mouse', 205, 300));
      canvas.dispatchEvent(pointer('pointerup', 'mouse', 205, 300));
    });
    // Chrome's own long-press menu is a PointerEvent from the touch
    assert.equal(canvas.dispatchEvent(mouseEvent('contextmenu', 200, 300, 0, 'touch')), false, 'the touch\'s native menu was shown');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
    assert.equal(canvas.dispatchEvent(mouseEvent('contextmenu', 200, 300, 0, 'touch')), false, 'the touch\'s trailing native menu was shown');
    mock.timers.reset();
    await act(settle);
    assert.equal(menus.length, 1, `the long press opened ${menus.length} viewer menus`);
  });

  it('a trackpad press far from the long press does not open its window', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    act(() => {
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
      canvas.dispatchEvent(pointer('pointerdown', 'mouse', 600, 100));
      canvas.dispatchEvent(pointer('pointerup', 'mouse', 600, 100));
    });
    assert.equal(canvas.dispatchEvent(mouseEvent('contextmenu', 200, 300)), false, 'the long press\'s trailing native menu was shown');
    mock.timers.reset();
    await act(settle);
    assert.equal(menus.length, 1);
  });

  it('a trackpad press near one long press does not open the window of the next', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 'mouse', 205, 300));
      canvas.dispatchEvent(pointer('pointerup', 'mouse', 205, 300));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    assert.equal(canvas.dispatchEvent(mouseEvent('contextmenu', 200, 300)), false, 'the second long press\'s native menu was shown');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
    mock.timers.reset();
    await act(settle);
    assert.equal(menus.length, 1);
  });
});

describe('a finger resting off the canvas is not part of a canvas gesture (#9122)', () => {
  /** `event` with a thumb resting on a side panel added to its `touches`, as a browser lists every finger on the screen. */
  function withRestingThumb<E extends Event>(event: E): E {
    const panel = document.body;
    const touches = [{ identifier: 99, target: panel, clientX: 20, clientY: 400 }, ...Array.from((event as unknown as TouchEvent).touches)];
    Object.defineProperty(event, 'touches', { value: touches });
    return event;
  }
  const touch = (kind: string, canvas: HTMLCanvasElement, points: Array<[number, number]>, touchType?: 'direct' | 'stylus') =>
    withRestingThumb(touchEvent(kind, canvas, points, touchType));

  it('a canvas tap selects while a thumb rests on a panel', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await act(async () => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
      await settle();
    });
    assert.equal(selectionCount(), 1, 'BUG: the thumb on the panel kept the canvas tap multi-touch');
    await act(async () => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[300, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
      await settle();
    });
    assert.equal(selectionCount(), 2, 'BUG: a second tap with the thumb still resting selected nothing');
  });

  it('after a Pan drag and a switch to Select, a one-finger drag orbits while the thumb still rests', () => {
    const { canvas, camera, activeToolRef } = rig('pan');
    const direction = viewDirection(camera);
    act(() => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touch('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
    });
    assert.equal(viewDirection(camera), direction, 'the Pan drag did not pan');
    const panned = pos(camera);
    assert.notEqual(panned, JSON.stringify({ x: 0, y: 0, z: 10 }), 'BUG: the one-finger Pan drag was read as two fingers and did not pan');
    activeToolRef.current = 'select';
    act(() => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touch('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
    });
    assert.notEqual(viewDirection(camera), direction, 'BUG: the drag in Select still panned, the drag type kept from Pan');
  });

  it('a second canvas finger landing late still pinches, with the thumb resting', () => {
    const { canvas, camera } = rig('select');
    act(() => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touch('touchstart', canvas, [[400, 300], [480, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touch('touchmove', canvas, [[400 - 10 * i, 300], [480 + 10 * i, 300]]));
    });
    const eye = camera.getPosition();
    assert.ok(eye.z < 10, `the pinch did not zoom in (z ${eye.z})`);
    const direction = viewDirection(camera);
    act(() => canvas.dispatchEvent(touch('touchend', canvas, [[360, 300]])));
    act(() => {
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touch('touchmove', canvas, [[360 + 20 * i, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
    });
    assert.notEqual(viewDirection(camera), direction, 'the finger left after the pinch did not orbit');
  });

  it('a tap after a two-finger pinch selects again once both canvas fingers lift, with the thumb resting', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await act(async () => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[400, 300], [480, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, [[400, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
      await settle();
    });
    assert.equal(selectionCount(), 0, 'a pinch selected');
    await act(async () => {
      canvas.dispatchEvent(touch('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touch('touchend', canvas, []));
      await settle();
    });
    assert.equal(selectionCount(), 1, 'BUG: the tap after the pinch was still read as multi-touch');
  });

  it('a Pencil hover releases a press whose pointerup never came, with the thumb resting', () => {
    const mouse = rig('select');
    pointerDrag(mouse.canvas, 'mouse');
    const expected = pos(mouse.camera);
    cleanup(); mouse.canvas.remove();
    const pen = rig('select');
    act(() => {
      pen.canvas.dispatchEvent(pointer('pointerdown', 'pen', 100, 100));
      pen.canvas.dispatchEvent(touch('touchstart', pen.canvas, [[100, 100]], 'stylus'));
      // a capture-phase listener stopped this pointerup before the mouse controls saw it
      pen.canvas.dispatchEvent(touch('touchend', pen.canvas, []));
      pen.canvas.dispatchEvent(pointer('pointermove', 'pen', 400, 300));
    });
    pointerDrag(pen.canvas, 'pen');
    assert.equal(pos(pen.camera), expected, 'BUG: the thumb on the panel kept the pen press touch-owned');
  });
});
