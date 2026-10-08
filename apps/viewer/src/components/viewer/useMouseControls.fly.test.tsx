/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Right-button fly mode as the canvas sees it. `flyControls.test.ts` covers
 * the controller; this mounts the real hook and dispatches real pointer and
 * wheel events, because the routing (right button looks instead of panning,
 * the wheel sets speed instead of zooming, a plain right-click still opens the
 * context menu) only exists in `useMouseControls`.
 *
 * It deliberately imports no fly module: the revert oracle reverts the branch's
 * production files, and a test importing a module that revert deletes dies at
 * load instead of failing on an assertion. Speed-level arithmetic lives in
 * `flyControls.test.ts`; here the wheel is observed through the camera alone.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { mousePointer as pointer, mountMouseControls as mount, cleanupMouseControls } from '@/test/mouse-controls-fixture.js';

describe('useMouseControls right-button fly mode', () => {
  afterEach(cleanupMouseControls);

  it('right-drag looks around the camera instead of panning', () => {
    const { canvas, camera } = mount();
    const target0 = camera.getTarget();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(pointer('pointermove', 2, 460, 300));
    assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'a pan would have moved the camera');
    assert.ok(camera.getTarget().x > target0.x + 0.1, 'dragging right turns the view right');
    canvas.dispatchEvent(pointer('pointerup', 2, 460, 300));
  });

  /**
   * #5403: the canvas refuses capture while fly mode holds pointer lock
   * (InvalidStateError) or once the pointer is no longer active. The raw call
   * sat at the top of pointerdown and aborted the handler, so the drag never
   * started and the throw reached PostHog.
   */
  it('a pointerdown whose capture the canvas refuses still starts the drag (#5403)', () => {
    const { canvas, camera } = mount();
    Object.assign(canvas, {
      setPointerCapture: () => { throw new DOMException('Pointer lock is active.', 'InvalidStateError'); },
    });
    const target0 = camera.getTarget();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(pointer('pointermove', 2, 460, 300));
    assert.ok(camera.getTarget().x > target0.x + 0.1, 'the right-drag still turns the view');
    canvas.dispatchEvent(pointer('pointerup', 2, 460, 300));
  });

  it('the wheel does not zoom while flying, and zooms again after release', () => {
    const { canvas, camera } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    const wheel = (deltaY: number) => {
      const e = new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
      Object.defineProperties(e, { clientX: { value: 400 }, clientY: { value: 300 } });
      return e;
    };
    canvas.dispatchEvent(wheel(-120));
    assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'no zoom while flying');
    canvas.dispatchEvent(wheel(120)); // step the persisted fly speed back down

    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
    canvas.dispatchEvent(wheel(-120));
    assert.notDeepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'plain wheel zooms');
  });

  it('a plain right-click whose contextmenu fired on press still opens the menu on release', async () => {
    const { canvas, menus } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.equal(menus.length, 0, 'held back while the button is down');
    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(menus.length, 1);
  });

  /** #4868 review: `?controls=none` freezes the embed, and fly must not be a way around it. */
  it('a frozen view (controls=none) does not fly on the right button (#4868)', () => {
    const { canvas, camera } = mount();
    camera.setInteractionMode('none'); // what Viewport's setInteractionMode callback does
    const initial = useViewerStore.getState().interactionMode;
    useViewerStore.setState({ interactionMode: 'none' });
    try {
      canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
      canvas.dispatchEvent(pointer('pointermove', 2, 460, 330));
      canvas.dispatchEvent(pointer('pointerup', 2, 460, 330));
      assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 });
      assert.deepEqual(camera.getTarget(), { x: 0, y: 1.6, z: 0 }, 'a frozen view must not turn');
    } finally {
      useViewerStore.setState({ interactionMode: initial });
    }
  });

  /**
   * #4868 review: Alt-Tab with the button held and the pointerup never comes.
   * The flight has to end with the focus, and so does the hook's drag, or the
   * wheel keeps setting fly speed and the next move keeps looking.
   */
  it('losing window focus mid-flight hands the wheel back to zoom (#4868)', () => {
    const { canvas, camera } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    window.dispatchEvent(new Event('blur'));
    const e = new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true });
    Object.defineProperties(e, { clientX: { value: 400 }, clientY: { value: 300 } });
    canvas.dispatchEvent(e);
    assert.notDeepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'the wheel zooms again');
    const pose = { position: camera.getPosition(), target: camera.getTarget() };
    canvas.dispatchEvent(pointer('pointermove', 0, 460, 300));
    assert.deepEqual({ position: camera.getPosition(), target: camera.getTarget() }, pose, 'a buttonless move after the lost release must not move the camera');
  });

  /** #4868 review: a keys-only flight moved the camera under a stale hover tooltip. */
  it('pressing the right button clears the hover tooltip (#4868)', () => {
    let cleared = 0;
    const { canvas } = mount({ clearHover: () => { cleared++; } });
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    assert.ok(cleared > 0, 'the tooltip would otherwise ride along with the flight');
    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
  });

  /** #4868 review: an active measurement routed right-button moves to the measure drag instead of the look. */
  it('the right button flies in the measure tool, even with a measurement active (#4868)', () => {
    const point = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
    let updates = 0;
    const { canvas, camera } = mount({
      activeToolRef: { current: 'measure' },
      activeMeasurementRef: { current: { start: point, current: point, distance: 0 } },
      updateMeasurement: () => { updates++; },
    });
    const target0 = camera.getTarget();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(pointer('pointermove', 2, 460, 300));
    assert.ok(camera.getTarget().x > target0.x + 0.1, 'the right-drag looks around');
    assert.equal(updates, 0, 'and does not drag the measurement');
    canvas.dispatchEvent(pointer('pointerup', 2, 460, 300));
  });

  for (const modelCount of [1, 2]) {
    for (const tool of ['select', 'measure']) {
      it(`Shift+left pans with ${tool} across ${modelCount} model(s) (#5887)`, () => {
        const previous = useViewerStore.getState();
        const models = Array.from({ length: modelCount }, (_, i) =>
          fixtureModel(`model-${i}`, { idOffset: i * 1_000_000 }));
        useViewerStore.setState({ ...fixtureModels(...models), measureMode: 'drag', interactionMode: 'all' });
        try {
          const point = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
          let measureUpdates = 0;
          const { canvas, camera } = mount({
            activeToolRef: { current: tool },
            activeMeasurementRef: { current: { start: point, current: point, distance: 0 } },
            updateMeasurement: () => { measureUpdates++; },
          });
          const position = camera.getPosition();
          const target = camera.getTarget();
          canvas.dispatchEvent(pointer('pointerdown', 0, 400, 300, { shiftKey: true }));
          canvas.dispatchEvent(pointer('pointermove', 0, 460, 330, { shiftKey: true }));
          assert.notDeepEqual(camera.getTarget(), target, 'pan must translate the target');
          assert.notDeepEqual(camera.getPosition(), position, 'pan must translate the camera');
          assert.equal(camera.getPosition().x - position.x, camera.getTarget().x - target.x);
          assert.equal(measureUpdates, 0, 'navigation must not update an active measurement');
          canvas.dispatchEvent(pointer('pointerup', 0, 460, 330, { shiftKey: true }));
        } finally {
          useViewerStore.setState({
            models: previous.models, activeModelId: previous.activeModelId,
            measureMode: previous.measureMode, interactionMode: previous.interactionMode,
          });
        }
      });
    }
  }
});
