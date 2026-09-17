/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly controller against a real renderer `Camera`, with a manual frame clock
 * so the movement loop is deterministic.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { createFlyController, type FlyController, type FlyControllerOptions } from './flyControls.js';
import { flySpeedStore } from './flySpeedStore.js';
import { DEFAULT_FLY_SPEED_LEVEL } from './flyNavigation.js';

interface Rig {
  fly: FlyController;
  camera: Camera;
  /** Advance the frame clock and run pending frames. */
  frames(n: number, ms?: number): void;
}

const rigs: FlyController[] = [];

function rig(extra: Pick<FlyControllerOptions, 'canFly' | 'onCancel'> = {}): Rig {
  const camera = new Camera();
  camera.setPosition(0, 1.6, 10);
  camera.setTarget(0, 1.6, 0);
  let t = 0;
  let pending: (() => void) | null = null;
  const fly = createFlyController({
    camera,
    onChange: () => {},
    keyTarget: window,
    requestFrame: (cb) => { pending = cb; return 1; },
    cancelFrame: () => { pending = null; },
    now: () => t,
    ...extra,
  });
  rigs.push(fly);
  return {
    fly,
    camera,
    frames(n, ms = 16) {
      for (let i = 0; i < n; i++) {
        t += ms;
        const cb = pending;
        pending = null;
        cb?.();
      }
    },
  };
}

const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent(type, { code, key: code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
};

describe('createFlyController', () => {
  afterEach(() => {
    while (rigs.length) rigs.pop()!.dispose();
    window.dispatchEvent(new Event('blur'));
    flySpeedStore.setLevel(DEFAULT_FLY_SPEED_LEVEL);
  });

  it('W flies forward while active, and stops when released', () => {
    const { fly, camera, frames } = rig();
    fly.begin();
    key('keydown', 'KeyW');
    frames(30);
    const moved = camera.getPosition();
    assert.ok(moved.z < 10 - 0.1, `expected forward (-z) travel, at z=${moved.z}`);
    assert.ok(Math.abs(moved.x) < 1e-9 && Math.abs(moved.y - 1.6) < 1e-9);
    assert.ok(Math.abs(camera.getTarget().z - (moved.z - 10)) < 1e-9, 'target travels with the camera');

    key('keyup', 'KeyW');
    frames(30);
    const settled = camera.getPosition().z;
    frames(10);
    assert.equal(camera.getPosition().z, settled, 'no drift once the key is up');
  });

  it('E rises and Q sinks', () => {
    const { fly, camera, frames } = rig();
    fly.begin();
    key('keydown', 'KeyE');
    frames(20);
    const risen = camera.getPosition().y;
    assert.ok(risen > 1.7);
    key('keyup', 'KeyE');
    key('keydown', 'KeyQ');
    frames(40);
    assert.ok(camera.getPosition().y < risen);
  });

  it('does nothing when not flying, and ends the loop on end()', () => {
    const { fly, camera, frames } = rig();
    key('keydown', 'KeyW');
    frames(20);
    assert.equal(camera.getPosition().z, 10);
    fly.begin();
    frames(20);
    assert.equal(fly.end(), 'flew', 'W held from before the press still flies');
    const z = camera.getPosition().z;
    frames(20);
    assert.equal(camera.getPosition().z, z);
  });

  it('swallows movement keydowns while flying so same-letter shortcuts stay quiet', () => {
    const { fly } = rig();
    let seen = 0;
    const shortcut = () => { seen++; };
    window.addEventListener('keydown', shortcut); // bubble, like useKeyboardShortcuts
    try {
      key('keydown', 'KeyE');
      assert.equal(seen, 1, 'E reaches shortcuts when not flying');
      key('keyup', 'KeyE');
      fly.begin();
      const e = key('keydown', 'KeyE');
      assert.equal(seen, 1, 'E must not toggle edit mode mid-flight');
      assert.equal(e.defaultPrevented, true);
      key('keydown', 'KeyT');
      assert.equal(seen, 2, 'non-fly keys are untouched');
    } finally {
      window.removeEventListener('keydown', shortcut);
    }
  });

  it('a right-click that barely moved keeps its context menu; a real look does not', () => {
    const { fly, camera } = rig();
    fly.begin();
    const before = camera.getTarget();
    fly.look(2, 0);
    assert.notDeepEqual(camera.getTarget(), before, 'even a nudge turns the view');
    fly.deferContextMenu();
    assert.equal(fly.end(), 'menu', 'a 2px twitch is still a click');

    fly.begin();
    fly.look(30, 10);
    fly.deferContextMenu();
    assert.equal(fly.end(), 'flew', 'a real look must not pop the menu on release');
  });

  /** A stub canvas that records pointer-lock requests. */
  function lockable() {
    const doc = Object.assign(new EventTarget(), {
      pointerLockElement: null as unknown,
      exitPointerLock: () => {
        doc.pointerLockElement = null;
        doc.dispatchEvent(new Event('pointerlockchange'));
      },
    });
    const canvas = {
      ownerDocument: doc,
      requested: 0,
      requestPointerLock: (options?: { unadjustedMovement?: boolean }) => {
        canvas.requested++;
        assert.equal(options?.unadjustedMovement, true, 'ask for raw deltas, without OS acceleration');
        doc.pointerLockElement = canvas;
        doc.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      },
    };
    return { canvas, doc, el: canvas as unknown as Element };
  }

  /**
   * The whole reason the lock is lazy: while the pointer is locked the browser
   * fires no `contextmenu` at all, so locking on the press killed the
   * right-click menu outright. A click must never take the lock.
   */
  it('does not lock the pointer for a plain right-click', () => {
    const { fly } = rig();
    const { canvas, el } = lockable();
    fly.begin(el);
    fly.look(1, 0); // a twitch, below the gesture threshold
    fly.deferContextMenu();
    assert.equal(canvas.requested, 0, 'no lock, so the browser still fires its menu');
    assert.equal(fly.end(), 'menu');
  });

  /**
   * Pointer lock pins the cursor, so `clientX` stops changing and only
   * `movementX/Y` still report the mouse. A controller that kept reading the
   * client deltas would simply stop looking once the lock engaged.
   */
  it('locks once a look starts, then looks with movement deltas', () => {
    const { fly, camera } = rig();
    const { canvas, doc, el } = lockable();
    fly.begin(el);
    assert.equal(canvas.requested, 0, 'the press alone does not lock');

    fly.look(8, 0); // a real look, with the cursor still free
    assert.equal(canvas.requested, 1);
    assert.equal(doc.pointerLockElement, canvas);

    const before = camera.getTarget();
    fly.look(0, 0, 40, 0); // now the cursor is pinned; only the mouse moved
    assert.ok(camera.getTarget().x > before.x + 0.1, 'movement deltas must drive the look');

    assert.equal(fly.end(), 'flew');
    assert.equal(doc.pointerLockElement, null, 'the lock is released on button-up');
    assert.equal(fly.consumeMenuSuppression(), true, 'the menu the lock withheld must not fire on release');
    assert.equal(fly.consumeMenuSuppression(), false, 'and only once');
  });

  /**
   * The hold is the primary rule: fly mode must engage on a held button even
   * if the mouse never moves, or a keys-only flight would never lock.
   */
  it('a held button becomes a fly gesture even with the mouse still', () => {
    const { fly, frames } = rig();
    const { canvas, el } = lockable();
    fly.begin(el);
    frames(3, 60); // ~180ms: still a click
    assert.equal(canvas.requested, 0);
    frames(2, 60); // past 250ms
    assert.equal(canvas.requested, 1, 'the hold takes the lock');
    assert.equal(fly.end(), 'flew', 'and the release must not pop a menu');
  });

  it('a short right-click keeps its menu and never locks', () => {
    const { fly, frames } = rig();
    const { canvas, el } = lockable();
    fly.begin(el);
    frames(2, 40); // 80ms, a quick click
    assert.equal(fly.end(), 'none');
    assert.equal(canvas.requested, 0);
    assert.equal(fly.consumeMenuSuppression(), false, 'the browser menu must reach the viewer');
  });

  it('falls back to cursor deltas when the lock is refused', async () => {
    const { fly, camera } = rig();
    const doc = { pointerLockElement: null, exitPointerLock: () => {} };
    const canvas = { ownerDocument: doc, requestPointerLock: () => Promise.reject(new Error('refused')) };
    fly.begin(canvas as unknown as Element);
    fly.look(8, 0); // triggers the (failing) lock request
    await new Promise((r) => setTimeout(r, 0));
    const before = camera.getTarget();
    fly.look(40, 0, 0, 0);
    assert.ok(camera.getTarget().x > before.x + 0.1, 'unlocked: the client-coordinate delta still looks');
  });

  it('wheel steps the shared speed level and cancels the default', () => {
    const { fly } = rig();
    fly.begin();
    const start = flySpeedStore.get().level;
    let prevented = false;
    fly.wheel({ deltaY: -100, deltaMode: 0, preventDefault: () => { prevented = true; } });
    assert.equal(flySpeedStore.get().level, start + 1);
    assert.equal(prevented, true);
    for (let i = 0; i < 20; i++) fly.wheel({ deltaY: 100, deltaMode: 0, preventDefault: () => {} });
    assert.equal(flySpeedStore.get().level, 0, 'clamped at the slowest level');
  });

  /** Travel over 30 frames of held W, at `level`, with optional modifiers. */
  const travel = (level: number, init: KeyboardEventInit = {}) => {
    flySpeedStore.setLevel(level);
    const { fly, camera, frames } = rig();
    fly.begin();
    key('keydown', 'KeyW', init);
    frames(30);
    key('keyup', 'KeyW');
    fly.end();
    window.dispatchEvent(new Event('blur')); // drop any modifier this run held
    return 10 - camera.getPosition().z;
  };

  it('a faster level covers more ground in the same time', () => {
    const slow = travel(1);
    const fast = travel(5);
    assert.ok(fast > slow * 4, `fast ${fast} vs slow ${slow}`);
  });

  it('Shift speeds up and Alt slows down, from the same level', () => {
    const plain = travel(3);
    const sprint = travel(3, { shiftKey: true });
    const precise = travel(3, { altKey: true });
    assert.ok(sprint > plain * 2, `sprint ${sprint} vs plain ${plain}`);
    assert.ok(precise < plain / 2, `precise ${precise} vs plain ${plain}`);
    assert.ok(precise > 0, 'Alt slows the flight down, it does not stop it');
  });

  /**
   * Ctrl is deliberately NOT the slow modifier: Chrome and Edge reserve Ctrl+W
   * for "close tab" and a page cannot cancel it, so binding it would close the
   * viewer on the most-used fly key.
   */
  it('leaves Ctrl alone', () => {
    const plain = travel(3);
    const withCtrl = travel(3, { ctrlKey: true });
    assert.ok(Math.abs(withCtrl - plain) < plain * 0.01, `ctrl ${withCtrl} should match plain ${plain}`);
  });

  /**
   * #4868 review: Alt-Tab away with the button held and the release lands in
   * another window, so no pointerup ever reaches the canvas. The session has to
   * end on its own, or WASD keeps flying (and swallowing shortcuts) back in the
   * viewer with no button held.
   */
  for (const [name, loseFocus] of [
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
    ['the tab going hidden', () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
      } finally {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      }
    }],
  ] as const) {
    it(`${name} ends the flight, not just the held keys (#4868)`, () => {
      let cancelled = 0;
      const { fly, camera, frames } = rig({ onCancel: () => { cancelled++; } });
      fly.begin();
      loseFocus();
      assert.equal(fly.isActive(), false, 'the session must not outlive focus');
      assert.equal(cancelled, 1, 'the caller is told, so it can drop its drag state');
      assert.equal(flySpeedStore.get().active, false);
      key('keydown', 'KeyW');
      frames(30);
      assert.equal(camera.getPosition().z, 10, 'W without the button held must not fly');
      key('keyup', 'KeyW');
      assert.equal(fly.end(), 'none', 'the late pointerup finds nothing to end');
    });
  }

  it('losing the pointer lock mid-flight (Esc) ends the flight (#4868)', () => {
    let cancelled = 0;
    const { fly } = rig({ onCancel: () => { cancelled++; } });
    const { doc, el } = lockable();
    fly.begin(el);
    fly.look(20, 0);
    assert.notEqual(doc.pointerLockElement, null, 'precondition: the look took the lock');
    doc.exitPointerLock(); // what the browser does on Esc
    assert.equal(fly.isActive(), false);
    assert.equal(cancelled, 1);
  });

  it('focus moving between elements inside the page does not end the flight', () => {
    const { fly } = rig();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.focus();
      fly.begin();
      input.blur(); // reaches the window's capture listener, but the window kept focus
      assert.equal(fly.isActive(), true);
    } finally {
      input.remove();
    }
  });

  it('a normal release does not report a cancel', () => {
    let cancelled = 0;
    const { fly } = rig({ onCancel: () => { cancelled++; } });
    const { el } = lockable();
    fly.begin(el);
    fly.look(20, 0);
    assert.equal(fly.end(), 'flew');
    assert.equal(cancelled, 0);
  });

  /** #4868 review: `?controls=none` freezes the embed; fly must not be a way around it. */
  it('does not start, look or move while the interaction policy forbids it (#4868)', () => {
    let allowed = false;
    const { fly, camera, frames } = rig({ canFly: () => allowed });
    assert.equal(fly.begin(), false, 'a frozen view refuses the session');
    assert.equal(fly.isActive(), false);

    allowed = true;
    assert.equal(fly.begin(), true);
    allowed = false; // e.g. a live SET_CONFIG froze the view mid-flight
    const target = camera.getTarget();
    fly.look(40, 0);
    key('keydown', 'KeyW');
    frames(30);
    key('keyup', 'KeyW');
    assert.deepEqual(camera.getTarget(), target, 'no look under a frozen policy');
    assert.equal(camera.getPosition().z, 10, 'no travel under a frozen policy');
  });

  /**
   * #4868 review: a flight whose trailing `contextmenu` never arrived left the
   * suppression armed, and it swallowed the genuine menu of a quick right-click
   * made inside that window.
   */
  it('a new press clears the previous flight\'s menu suppression (#4868)', () => {
    const { fly } = rig();
    const { el } = lockable();
    fly.begin(el);
    fly.look(20, 0);
    assert.equal(fly.end(), 'flew');
    fly.begin(el); // a quick right-click right after, with no menu event in between
    assert.equal(fly.end(), 'none');
    assert.equal(fly.consumeMenuSuppression(), false, 'the click\'s own menu must reach the viewer');
  });

  /**
   * #4868 review: 4px of travel took the pointer lock (which makes the browser
   * withhold `contextmenu`) yet still ended as a plain click, so the menu was
   * lost. Whatever takes the lock must classify as a gesture, and vice versa.
   */
  it('one threshold decides both the lock and the click/gesture verdict (#4868)', () => {
    for (let px = 1; px <= 12; px++) {
      const { fly } = rig();
      const { canvas, el } = lockable();
      fly.begin(el);
      fly.look(px, 0);
      const locked = canvas.requested > 0;
      const verdict = fly.end();
      assert.equal(locked, verdict === 'flew', `${px}px: locked=${locked} but end()=${verdict}`);
      fly.dispose();
    }
  });
});
