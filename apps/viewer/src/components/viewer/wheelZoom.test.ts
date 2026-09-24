/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2683 - Ctrl/Cmd held gives a finer wheel zoom, QGIS-style.
 *
 * The fixture is a real `WheelEvent` dispatched at a real canvas through a
 * real `Camera`, because every trap in this feature lives in the gap between a
 * hand-rolled event object and the one a browser sends:
 *
 *  - a trackpad pinch arrives as a wheel event with `ctrlKey: true` and
 *    `deltaMode: 0` and no key ever pressed, so a naive `e.ctrlKey` test
 *    silently rewrites pinch-zoom;
 *  - Ctrl+wheel is the browser's page-zoom shortcut, so the handler has to
 *    cancel the default or the whole page zooms instead of the model.
 *
 * The assertions are at the camera level (how far the camera actually moved),
 * not at the delta level, so a change that scales the delta but never reaches
 * the camera cannot pass.
 */

import '../../test/setup-dom.js';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { Camera } from '@ifc-lite/renderer';

import {
  applyWheelZoom,
  createWheelSurfacePicker,
  createFineZoomModifierTracker,
  isFineZoomWheel,
  wheelZoomDelta,
  FINE_ZOOM_STEP_FACTOR,
} from './wheelZoom.js';

/** One ordinary mouse-wheel notch, as Chrome sends it. */
const NOTCH_DELTA_Y = 120;

/**
 * An 800 x 600 CSS-px canvas whose drawing buffer is `pixelRatio` times that,
 * as the renderer sizes it (#5383). happy-dom does no layout, so the CSS box
 * is stubbed; without it `getBoundingClientRect()` is 0 x 0.
 */
function makeCanvas(pixelRatio = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 800 * pixelRatio;
  canvas.height = 600 * pixelRatio;
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * A wheel event as a browser dispatches it: a real `WheelEvent`, cancelable,
 * with `deltaMode` set and the modifier flags a pinch or a held key carries.
 *
 * The `defineProperties` is load-bearing, not decoration. happy-dom's
 * `WheelEvent` constructor implements only the delta half of the init dict and
 * drops the `MouseEvent` half: `new WheelEvent('wheel', { ctrlKey: true,
 * clientX: 400 })` comes back with `ctrlKey === undefined` and
 * `clientX === undefined`. Without this, every assertion about the modifier
 * would run against an event that never had one - the tests would pass while
 * testing nothing, which is the exact failure they exist to catch. The
 * fixture-integrity test below keeps that honest.
 */
function wheelEvent(init: { ctrlKey?: boolean; metaKey?: boolean; deltaY?: number } = {}): WheelEvent {
  const e = new WheelEvent('wheel', {
    deltaY: init.deltaY ?? NOTCH_DELTA_Y,
    deltaMode: 0, // WheelEvent.DOM_DELTA_PIXEL
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(e, {
    ctrlKey: { value: init.ctrlKey ?? false, configurable: true },
    metaKey: { value: init.metaKey ?? false, configurable: true },
    // Canvas centre: the cursor anchor then contributes no lateral drift, so
    // the modified and unmodified runs differ only in step size.
    clientX: { value: 400, configurable: true },
    clientY: { value: 300, configurable: true },
  });
  return e;
}

/** Camera travel and distance change produced by one wheel event. */
function zoomOnce(e: WheelEvent, opts: { fineModifierHeld: boolean }): { travel: number; distanceDelta: number } {
  const canvas = makeCanvas();
  const camera = new Camera();
  const before = { ...camera.getPosition() };
  const distanceBefore = camera.getDistance();

  applyWheelZoom(e, { camera, canvas, fastZoom: false, fineModifierHeld: opts.fineModifierHeld });

  const after = camera.getPosition();
  return {
    travel: Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z),
    distanceDelta: Math.abs(camera.getDistance() - distanceBefore),
  };
}

describe('wheel zoom - the fine-step modifier (#2683)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('has a fixture that carries what a browser actually dispatches', () => {
    // If this drifts, every modifier assertion below silently stops testing
    // the modifier. happy-dom already dropped these once.
    const e = wheelEvent({ ctrlKey: true });
    assert.strictEqual(e.deltaY, NOTCH_DELTA_Y, 'a notch must have a delta');
    assert.strictEqual(e.deltaMode, 0, 'deltaMode must exist and be pixel mode');
    assert.strictEqual(e.ctrlKey, true, 'a pinch/ctrl wheel event carries ctrlKey');
    assert.strictEqual(e.metaKey, false);
    assert.strictEqual(e.clientX, 400, 'the cursor anchor needs client coordinates');
    assert.strictEqual(e.clientY, 300);
    assert.strictEqual(e.cancelable, true, 'preventDefault is only observable on a cancelable event');
    assert.strictEqual(wheelEvent().ctrlKey, false, 'the unmodified fixture must be unmodified');
  });

  it('moves the camera LESS for the same deltaY when the modifier is held', () => {
    const plain = zoomOnce(wheelEvent(), { fineModifierHeld: false });
    const fine = zoomOnce(wheelEvent({ ctrlKey: true }), { fineModifierHeld: true });

    assert.ok(plain.travel > 0, 'the unmodified notch must move the camera at all');
    assert.ok(fine.travel > 0, 'the fine notch must still move the camera - finer, not dead');
    assert.ok(
      fine.travel < plain.travel,
      `fine travel ${fine.travel} should be smaller than plain travel ${plain.travel}`,
    );
    assert.ok(
      fine.distanceDelta < plain.distanceDelta,
      `fine distance delta ${fine.distanceDelta} should be smaller than plain ${plain.distanceDelta}`,
    );
    // Not merely "smaller": a step the user can feel as finer. The renderer
    // clamps a 120px notch at MAX_ZOOM_DELTA, so the observed ratio is wider
    // than FINE_ZOOM_STEP_FACTOR itself; half is a floor either way.
    assert.ok(
      fine.travel < plain.travel * 0.5,
      `fine travel ${fine.travel} should be well under half of ${plain.travel}`,
    );
  });

  it('leaves the unmodified wheel bit-for-bit as it was', () => {
    // The reference is the call the handler used to make: raw deltaY straight
    // into camera.zoom with the same cursor anchor.
    const canvas = makeCanvas();
    const reference = new Camera();
    reference.zoom(NOTCH_DELTA_Y, false, 400, 300, canvas.width, canvas.height, false);

    const subject = new Camera();
    applyWheelZoom(wheelEvent(), {
      camera: subject,
      canvas,
      fastZoom: false,
      fineModifierHeld: false,
    });

    assert.deepStrictEqual(subject.getPosition(), reference.getPosition());
    assert.deepStrictEqual(subject.getTarget(), reference.getTarget());
    assert.strictEqual(subject.getDistance(), reference.getDistance());
  });

  it('anchors at the cursor on a HiDPI canvas, in CSS px on both sides (#5383)', () => {
    // Off-centre cursor, so a wrong extent visibly moves the anchor. The
    // reference is the anchor the user pointed at: CSS cursor over CSS box.
    const e = wheelEvent();
    Object.defineProperties(e, {
      clientX: { value: 700, configurable: true },
      clientY: { value: 100, configurable: true },
    });
    const reference = new Camera();
    reference.zoom(NOTCH_DELTA_Y, false, 700, 100, 800, 600, false);

    const subject = new Camera();
    applyWheelZoom(e, { camera: subject, canvas: makeCanvas(2), fastZoom: false, fineModifierHeld: false });

    assert.deepStrictEqual(subject.getTarget(), reference.getTarget());
    assert.deepStrictEqual(subject.getPosition(), reference.getPosition());
  });

  it('calls preventDefault when the modifier is active, so the browser does not zoom the page', () => {
    const canvas = makeCanvas();
    const camera = new Camera();
    const e = wheelEvent({ ctrlKey: true });

    // Dispatched, not just constructed: `defaultPrevented` is what the browser
    // reads to decide whether to run its own Ctrl+wheel page zoom, and the
    // listener is registered non-passive exactly as useMouseControls does.
    canvas.addEventListener(
      'wheel',
      (ev) => {
        applyWheelZoom(ev as WheelEvent, {
          camera,
          canvas,
          fastZoom: false,
          fineModifierHeld: true,
        });
      },
      { passive: false },
    );
    canvas.dispatchEvent(e);

    assert.strictEqual(e.defaultPrevented, true, 'ctrl+wheel must be cancelled');
  });

  it('also calls preventDefault on the unmodified wheel', () => {
    const canvas = makeCanvas();
    const camera = new Camera();
    const e = wheelEvent();
    canvas.addEventListener(
      'wheel',
      (ev) => {
        applyWheelZoom(ev as WheelEvent, {
          camera,
          canvas,
          fastZoom: false,
          fineModifierHeld: false,
        });
      },
      { passive: false },
    );
    canvas.dispatchEvent(e);

    assert.strictEqual(e.defaultPrevented, true, 'plain wheel must stay cancelled too');
  });

  it('treats a trackpad pinch (synthesised ctrlKey, no key pressed) as a normal-speed zoom', () => {
    // macOS, and Chromium precision touchpads elsewhere, send exactly this.
    const pinch = zoomOnce(wheelEvent({ ctrlKey: true }), { fineModifierHeld: false });
    const plain = zoomOnce(wheelEvent(), { fineModifierHeld: false });

    assert.strictEqual(pinch.travel, plain.travel, 'a pinch must not be slowed to the fine step');
  });

  it('ignores a stale held-flag when the wheel event says the key is up', () => {
    // Focus can be lost with Ctrl down, stranding the flag; the wheel event
    // still reports the truth, and both halves are required.
    assert.strictEqual(isFineZoomWheel({ ctrlKey: false, metaKey: false }, true), false);
    assert.strictEqual(isFineZoomWheel({ ctrlKey: true, metaKey: false }, true), true);
    assert.strictEqual(isFineZoomWheel({ ctrlKey: false, metaKey: true }, true), true);
    assert.strictEqual(isFineZoomWheel({ ctrlKey: true, metaKey: false }, false), false);
  });

  it('scales the delta by the fine factor and leaves it alone otherwise', () => {
    assert.strictEqual(
      wheelZoomDelta({ deltaY: NOTCH_DELTA_Y, ctrlKey: true, metaKey: false }, true),
      NOTCH_DELTA_Y * FINE_ZOOM_STEP_FACTOR,
    );
    assert.strictEqual(
      wheelZoomDelta({ deltaY: NOTCH_DELTA_Y, ctrlKey: false, metaKey: false }, false),
      NOTCH_DELTA_Y,
    );
    assert.ok(FINE_ZOOM_STEP_FACTOR > 0 && FINE_ZOOM_STEP_FACTOR < 1, 'finer, not faster and not dead');
  });
});

describe('fine-zoom modifier tracker - real key presses only (#2683)', () => {
  it('opens on a Ctrl keydown and closes on its keyup', () => {
    const tracker = createFineZoomModifierTracker(window);
    try {
      assert.strictEqual(tracker.isHeld(), false, 'starts closed');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
      assert.strictEqual(tracker.isHeld(), true);

      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
      assert.strictEqual(tracker.isHeld(), false);
    } finally {
      tracker.dispose();
    }
  });

  it('still sees the key when a focused editor stops it from bubbling', () => {
    // `TextAnnotationEditor.tsx:63` calls `e.stopPropagation()` on every
    // keydown so the canvas does not act on typing. A bubble-phase listener on
    // `window` would never observe the Ctrl press while that editor has focus,
    // and the next wheel gesture over the canvas would silently take the
    // normal step. Capture runs window-first, before any child can stop it.
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    const swallow = (e: Event) => e.stopPropagation();
    editor.addEventListener('keydown', swallow);
    editor.addEventListener('keyup', swallow);

    const tracker = createFineZoomModifierTracker(window);
    try {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }),
      );
      assert.strictEqual(
        tracker.isHeld(),
        true,
        'a focused editor swallowing keydown must not disable the fine-zoom modifier',
      );

      editor.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }),
      );
      assert.strictEqual(tracker.isHeld(), false, 'and the release must still be seen');
    } finally {
      tracker.dispose();
      editor.remove();
    }
  });

  it('accepts Cmd on macOS keyboards', () => {
    const tracker = createFineZoomModifierTracker(window);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      assert.strictEqual(tracker.isHeld(), true);
    } finally {
      tracker.dispose();
    }
  });

  it('stays closed for a pinch, which fires no keyboard event at all', () => {
    const canvas = makeCanvas();
    const tracker = createFineZoomModifierTracker(window);
    try {
      canvas.dispatchEvent(wheelEvent({ ctrlKey: true }));
      assert.strictEqual(tracker.isHeld(), false, 'a wheel event must never open the gate');
    } finally {
      tracker.dispose();
    }
  });

  it('resets when the window loses focus with the key down', () => {
    const tracker = createFineZoomModifierTracker(window);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
      assert.strictEqual(tracker.isHeld(), true);

      window.dispatchEvent(new Event('blur'));
      assert.strictEqual(tracker.isHeld(), false);
    } finally {
      tracker.dispose();
    }
  });

  it('stops listening after dispose', () => {
    const tracker = createFineZoomModifierTracker(window);
    tracker.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    assert.strictEqual(tracker.isHeld(), false);
  });
});

describe('wheel zoom toward the surface under the cursor (#5393)', () => {
  // A thin wall, the plane z = 2, straight under the canvas-centre cursor of a
  // camera at z = 10 looking at the origin: the surface the user zooms at.
  const WALL_Z = 2;

  function rig() {
    const canvas = makeCanvas();
    const camera = new Camera();
    camera.setAspect(800 / 600);
    camera.setPosition(0, 0, 10);
    camera.setTarget(0, 0, 0);
    const picks: Array<[number, number]> = [];
    const pickSurface = (x: number, y: number) => { picks.push([x, y]); return { x: 0, y: 0, z: WALL_Z }; };
    return { canvas, camera, picks, pickSurface };
  }

  /** `n` wheel-in notches at the canvas centre; the camera's z after each. */
  function zoomIn(r: ReturnType<typeof rig>, n: number, withSurface: boolean): number[] {
    const zs: number[] = [];
    for (let i = 0; i < n; i++) {
      applyWheelZoom(wheelEvent({ deltaY: -NOTCH_DELTA_Y }), {
        camera: r.camera, canvas: r.canvas, fastZoom: false, fineModifierHeld: false,
        ...(withSurface ? { pickSurface: r.pickSurface } : {}),
      });
      zs.push(r.camera.getPosition().z);
    }
    return zs;
  }

  it('without a surface pick, repeated notches pass through the wall (the defect)', () => {
    const zs = zoomIn(rig(), 60, false);
    assert.ok(Math.min(...zs) < WALL_Z, `plain zoom never passed the wall: min z ${Math.min(...zs)}`);
  });

  it('with a surface pick, repeated notches approach the wall and never pass it', () => {
    const r = rig();
    const zs = zoomIn(r, 60, true);
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `notch ${i}: camera at z ${z} is at or behind the wall`));
    assert.ok(zs[zs.length - 1] - WALL_Z < 0.1, `60 notches got close to the wall: z ${zs[zs.length - 1]}`);
  });

  it('picks once per gesture, not once per notch', () => {
    const r = rig();
    zoomIn(r, 20, true);
    assert.strictEqual(r.picks.length, 1, `picks: ${JSON.stringify(r.picks)}`);
    assert.deepStrictEqual(r.picks[0], [400, 300], 'picked at the cursor, in CSS px');
  });

  it('never picks under fast zoom, which ignores the surface (PR #5461 review)', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      applyWheelZoom(wheelEvent({ deltaY: -NOTCH_DELTA_Y }), {
        camera: r.camera, canvas: r.canvas, fastZoom: true, fineModifierHeld: false, pickSurface: r.pickSurface,
      });
    }
    assert.strictEqual(r.picks.length, 0);
  });

  it('re-picks when anything else moved the camera between notches (PR #5461 review)', () => {
    const r = rig();
    zoomIn(r, 3, true);
    assert.strictEqual(r.picks.length, 1);
    // A fast-zoom dolly (or orbit/pan) within the same gesture window moves the
    // camera off the cached point's ray: the next surface notch must re-pick.
    applyWheelZoom(wheelEvent({ deltaY: -NOTCH_DELTA_Y }), {
      camera: r.camera, canvas: r.canvas, fastZoom: true, fineModifierHeld: false, pickSurface: r.pickSurface,
    });
    zoomIn(r, 1, true);
    assert.strictEqual(r.picks.length, 2, 'a stale point was reused after the camera moved');
  });

  it('re-picks when the cursor moves beyond the gesture slop, or after a pause', () => {
    const r = rig();
    zoomIn(r, 2, true);
    const moved = wheelEvent({ deltaY: -NOTCH_DELTA_Y });
    Object.defineProperty(moved, 'clientX', { value: 410, configurable: true });
    applyWheelZoom(moved, { camera: r.camera, canvas: r.canvas, fastZoom: false, fineModifierHeld: false, pickSurface: r.pickSurface });
    assert.strictEqual(r.picks.length, 2, 'a 10 px cursor move starts a new gesture');
    const realNow = Date.now;
    try {
      const t = realNow();
      Date.now = () => t + 1000; // past the 400 ms idle window
      applyWheelZoom(moved, { camera: r.camera, canvas: r.canvas, fastZoom: false, fineModifierHeld: false, pickSurface: r.pickSurface });
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(r.picks.length, 3, 'a pause starts a new gesture');
  });

  it('the viewer picker skips the raycast while streaming, on large models and with a robust anchor', () => {
    let raycasts = 0;
    const small = { getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 0 };
    const large = { getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 1_000_000 };
    const renderer = (scene: typeof small) => ({
      getScene: () => scene,
      raycastScene: () => { raycasts++; return { intersection: { point: { x: 0, y: 0, z: WALL_Z } } }; },
    });
    const opts = (isStreaming: boolean) => () => ({ isStreaming, hiddenIds: new Set<number>(), isolatedIds: null });
    const noAnchor = { getOrbitAnchorBounds: () => null };
    const anchor = { getOrbitAnchorBounds: () => ({}) };

    assert.deepStrictEqual(createWheelSurfacePicker(renderer(small), noAnchor, opts(false))(1, 2), { x: 0, y: 0, z: WALL_Z });
    assert.strictEqual(raycasts, 1);
    assert.strictEqual(createWheelSurfacePicker(renderer(small), noAnchor, opts(true))(1, 2), null, 'streaming');
    assert.strictEqual(createWheelSurfacePicker(renderer(large), noAnchor, opts(false))(1, 2), null, 'large model');
    assert.strictEqual(createWheelSurfacePicker(renderer(small), anchor, opts(false))(1, 2), null, 'robust anchor');
    assert.strictEqual(raycasts, 1, 'no raycast ran for the gated cases');
  });

  it('never picks when zooming out, which cannot pass through anything', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      applyWheelZoom(wheelEvent({ deltaY: NOTCH_DELTA_Y }), {
        camera: r.camera, canvas: r.canvas, fastZoom: false, fineModifierHeld: false, pickSurface: r.pickSurface,
      });
    }
    assert.strictEqual(r.picks.length, 0);
  });
});
