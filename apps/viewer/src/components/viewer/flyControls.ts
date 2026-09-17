/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly mode controller: the DOM + camera half of `flyNavigation.ts`.
 *
 * `useMouseControls` calls `begin()` on a right-button press and `end()` on
 * its release; while active, mouse deltas go to `look()`, the wheel to
 * `wheel()`, and held movement keys drive a per-frame loop.
 *
 * A press is only a fly gesture once it is HELD ({@link HOLD_TO_FLY_MS}) or
 * moved. A short right-click stays a right-click: it never takes the pointer
 * lock and never suppresses the context menu, which matters because a locked
 * pointer makes the browser withhold `contextmenu` entirely.
 *
 * Keys are read by PHYSICAL position (`KeyboardEvent.code`), as games and
 * Unreal do, so the WASD cluster is the same hand position on AZERTY (ZQSD)
 * and other layouts. Shift flies faster, Alt slower (see
 * `FLY_PRECISION_FACTOR` for why the slow modifier is not Ctrl). While flying,
 * movement keydowns are swallowed in the capture phase so single-key viewer
 * shortcuts on the same letters (E edit mode, S snapping, A show all, D dock)
 * do not fire mid-flight.
 *
 * Neighbours: `flySpeedStore.ts` holds the speed level, `flyPointerLock.ts`
 * the browser's pointer-lock negotiation.
 */

import { isTextEntryTarget } from '@/lib/keyboard-event';
import {
  baseFlySpeed,
  createWheelStepper,
  flyDirection,
  flyLook,
  flyTranslate,
  FLY_PRECISION_FACTOR,
  FLY_SPEED_LEVELS,
  FLY_SPRINT_FACTOR,
  type FlyInput,
  type FlyPose,
  type Vec3,
} from './flyNavigation.js';
import { flySpeedStore, setFlySpeedState } from './flySpeedStore.js';
import { createFlyPointerLock } from './flyPointerLock.js';

/** The part of `Camera` fly mode drives. */
export interface FlyCamera {
  getPosition(): Vec3;
  getTarget(): Vec3;
  setPosition(x: number, y: number, z: number): void;
  setTarget(x: number, y: number, z: number): void;
  stopInertia(): void;
  getSceneBounds(): { min: Vec3; max: Vec3 } | null;
}

type KeyTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface FlyControllerOptions {
  camera: FlyCamera;
  /** Called after every camera change (render, rotation readouts, scale bar). */
  onChange: () => void;
  /**
   * The camera interaction policy. Fly neither starts nor moves the camera
   * while this is false: it drives the camera through its programmatic
   * setters, which the embed's `?controls=` freeze does not gate, so the
   * caller has to (#4868 review). Defaults to always allowed.
   */
  canFly?: () => boolean;
  /**
   * The session ended without a button release: the window lost focus, the
   * tab was hidden, or the pointer lock was taken away (Esc). The caller drops
   * its own drag state here, since no pointerup is coming.
   */
  onCancel?: () => void;
  keyTarget?: KeyTarget;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
}

/**
 * How a fly session ended:
 *  - `'flew'`: a fly gesture — the button was held past
 *    {@link HOLD_TO_FLY_MS}, the camera travelled, or the look passed
 *    {@link LOOK_CLICK_SLOP_PX}. No context menu belongs to it.
 *  - `'menu'`: a short click whose context menu the browser already fired
 *    (macOS/Linux fire it on press) and which must now be replayed.
 *  - `'none'`: a short click; the browser's own menu event is still to come.
 */
export type FlyEndResult = 'flew' | 'menu' | 'none';

export interface FlyController {
  isActive(): boolean;
  /**
   * Start flying. The element, when given, is the one pointer-locked once the
   * press becomes a gesture, so the cursor stops at the screen edge instead of
   * running off it mid-look. Returns false, without starting, when the
   * interaction policy forbids flying.
   */
  begin(element?: Element | null): boolean;
  /**
   * Look around. `movementX/Y` are the deltas to prefer while pointer lock is
   * held (they keep arriving past the screen edge); the client-coordinate
   * deltas are the fallback before the lock and when it was refused.
   */
  look(dx: number, dy: number, movementX?: number, movementY?: number): void;
  wheel(e: { deltaY: number; deltaMode: number; preventDefault(): void }): void;
  /** The browser fired `contextmenu` mid-press (macOS/Linux fire it on press); replay it on release if this was a click. */
  deferContextMenu(): void;
  /**
   * True when a `contextmenu` arriving right now belongs to a fly gesture that
   * has just ended, and must be swallowed rather than shown. Consumes the
   * suppression, so it answers once.
   */
  consumeMenuSuppression(): boolean;
  end(): FlyEndResult;
  dispose(): void;
}

const FORWARD_CODES = ['KeyW', 'ArrowUp'];
const BACK_CODES = ['KeyS', 'ArrowDown'];
const LEFT_CODES = ['KeyA', 'ArrowLeft'];
const RIGHT_CODES = ['KeyD', 'ArrowRight'];
const UP_CODES = ['KeyE', 'PageUp'];
const DOWN_CODES = ['KeyQ', 'PageDown'];
const FLY_CODES = new Set([...FORWARD_CODES, ...BACK_CODES, ...LEFT_CODES, ...RIGHT_CODES, ...UP_CODES, ...DOWN_CODES]);

/** Seconds for velocity to cover ~63% of the way to the input: short enough to feel direct, long enough not to jolt. */
const VELOCITY_SMOOTHING_S = 0.06;
/** Frame gaps longer than this (tab hidden, GC pause) are not integrated as one giant step. */
const MAX_FRAME_S = 0.1;
/**
 * Look travel, in pixels, past which a right-press is a gesture rather than a
 * click: it takes the pointer lock straight away, ahead of the hold timer, and
 * its release shows no context menu.
 *
 * ONE threshold for both on purpose (#4868 review). A lock taken below the
 * click verdict made the browser withhold `contextmenu` for a press that was
 * still classified as a click, so the menu was simply lost. It equals the
 * caller's own 5px client-coordinate drag threshold, and the summed travel is
 * never less than the displacement, so anything that caller counts as a drag
 * is a gesture here too. Under pointer lock the cursor does not move, which is
 * why the controller has to measure this itself.
 */
const LOOK_CLICK_SLOP_PX = 5;
/**
 * How long the right button must be held before the press is a fly gesture
 * rather than a click.
 *
 * This is the primary rule and movement is the fast path: hold the button and
 * fly mode engages (taking the pointer lock) even if the mouse never moves,
 * which is what makes a keys-only flight work; tap it and nothing happens but
 * the context menu, exactly as before this feature existed. 250ms is the usual
 * long-press threshold and is comfortably longer than a deliberate click.
 */
const HOLD_TO_FLY_MS = 250;
/**
 * How long after a fly gesture a `contextmenu` is still swallowed.
 *
 * Releasing the button exits the lock, and the browser can then fire the menu
 * event it withheld during it. Without this, every look would end in a context
 * menu — and the caller's drag threshold cannot see it, because a locked
 * cursor never moved.
 */
const MENU_SUPPRESSION_MS = 400;

export function createFlyController(opts: FlyControllerOptions): FlyController {
  const { camera, onChange } = opts;
  const keyTarget = opts.keyTarget ?? window;
  const requestFrame = opts.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = opts.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const now = opts.now ?? (() => performance.now());

  const canFly = opts.canFly ?? (() => true);

  const held = new Set<string>();
  // Esc (or the browser) taking the lock away mid-flight ends the session.
  const lock = createFlyPointerLock(() => cancel());
  const wheelStep = createWheelStepper();
  let shift = false;
  let alt = false;
  let active = false;
  let flew = false;
  let menuDeferred = false;
  let frameId: number | null = null;
  let lastFrame = 0;
  let lookTravel = 0;
  let pressedAt = 0;
  let suppressMenuUntil = -Infinity;
  let velocity: Vec3 = { x: 0, y: 0, z: 0 };

  const pose = (): FlyPose => ({ position: camera.getPosition(), target: camera.getTarget() });
  const apply = (next: FlyPose | null): void => {
    if (!next) return;
    camera.setPosition(next.position.x, next.position.y, next.position.z);
    camera.setTarget(next.target.x, next.target.y, next.target.z);
    onChange();
  };

  const axis = (pos: string[], neg: string[]): number =>
    (pos.some((c) => held.has(c)) ? 1 : 0) - (neg.some((c) => held.has(c)) ? 1 : 0);
  const readInput = (): FlyInput => ({
    forward: axis(FORWARD_CODES, BACK_CODES),
    right: axis(RIGHT_CODES, LEFT_CODES),
    up: axis(UP_CODES, DOWN_CODES),
  });

  const tick = (): void => {
    frameId = null;
    if (!active) return;
    const t = now();
    const dt = Math.min(MAX_FRAME_S, Math.max(0, (t - lastFrame) / 1000));
    lastFrame = t;
    if (!canFly()) {
      // Frozen mid-flight (a live config update): hold still, keep the session.
      velocity = { x: 0, y: 0, z: 0 };
      frameId = requestFrame(tick);
      return;
    }

    // The hold itself is what promotes a press to a gesture; the loop already
    // runs every frame, so it doubles as that timer.
    if (t - pressedAt >= HOLD_TO_FLY_MS) lock.request();

    const current = pose();
    const speed = baseFlySpeed(camera.getSceneBounds())
      * FLY_SPEED_LEVELS[flySpeedStore.get().level]
      * (shift ? FLY_SPRINT_FACTOR : 1)
      * (alt ? FLY_PRECISION_FACTOR : 1);
    const dir = flyDirection(current, readInput());
    const k = 1 - Math.exp(-dt / VELOCITY_SMOOTHING_S);
    velocity = {
      x: velocity.x + (dir.x * speed - velocity.x) * k,
      y: velocity.y + (dir.y * speed - velocity.y) * k,
      z: velocity.z + (dir.z * speed - velocity.z) * k,
    };
    if (Math.hypot(velocity.x, velocity.y, velocity.z) > speed * 1e-3) {
      apply(flyTranslate(current, { x: velocity.x * dt, y: velocity.y * dt, z: velocity.z * dt }));
      flew = true;
    } else {
      velocity = { x: 0, y: 0, z: 0 };
    }
    frameId = requestFrame(tick);
  };

  const onKeyDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    shift = ke.shiftKey;
    alt = ke.altKey;
    // Alt on its own reaches for the browser's menu bar on Edge and Firefox;
    // while flying it is the precision modifier, so keep it on the page.
    if (active && (ke.code === 'AltLeft' || ke.code === 'AltRight')) ke.preventDefault();
    if (!FLY_CODES.has(ke.code)) return;
    if (active) {
      // Capture phase on window runs before every other key listener, so
      // this keeps same-letter shortcuts from firing while flying.
      ke.preventDefault();
      ke.stopImmediatePropagation();
    } else if (isTextEntryTarget(ke)) {
      return;
    }
    held.add(ke.code);
  };
  // Key-ups always clear, whatever holds focus, so a key can never stick.
  const onKeyUp = (e: Event): void => {
    const ke = e as KeyboardEvent;
    shift = ke.shiftKey;
    alt = ke.altKey;
    held.delete(ke.code);
  };
  const stopLoop = (): void => {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
  };
  const stop = (): void => {
    active = false;
    stopLoop();
    lock.release();
    velocity = { x: 0, y: 0, z: 0 };
    setFlySpeedState({ active: false });
  };
  /** End a session no pointerup will end (#4868 review: flight survived focus loss). */
  function cancel(): void {
    if (!active) return;
    stop();
    opts.onCancel?.();
  }

  // Alt+Tab away and the key-up never arrives, which would strand the
  // modifier on; the blur that comes with it clears everything. The button's
  // release is lost the same way, so the window's own blur also ends the
  // flight (an element blur inside the page, caught by this capture listener,
  // does not).
  const onBlur = (e: Event): void => {
    held.clear();
    shift = false;
    alt = false;
    if (!(e.target instanceof Node)) cancel();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') cancel();
  };

  keyTarget.addEventListener('keydown', onKeyDown, true);
  keyTarget.addEventListener('keyup', onKeyUp, true);
  keyTarget.addEventListener('blur', onBlur, true);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    isActive: () => active,

    begin(element) {
      if (active) return true;
      if (!canFly()) return false;
      active = true;
      flew = false;
      menuDeferred = false;
      // A previous flight whose trailing `contextmenu` never came must not
      // swallow the menu of this press (#4868 review).
      suppressMenuUntil = -Infinity;
      lookTravel = 0;
      pressedAt = now();
      velocity = { x: 0, y: 0, z: 0 };
      // Armed, not locked: the lock waits for the hold or for movement.
      lock.arm(element ?? null);
      camera.stopInertia();
      lastFrame = pressedAt;
      frameId = requestFrame(tick);
      setFlySpeedState({ active: true });
      return true;
    },

    look(dx, dy, movementX, movementY) {
      if (!active || !canFly()) return;
      // Under pointer lock the client coordinates stop moving (the cursor is
      // pinned), so the movement deltas are the only live signal.
      const locked = lock.isLocked();
      const lookX = locked && movementX !== undefined ? movementX : dx;
      const lookY = locked && movementY !== undefined ? movementY : dy;
      if (lookX === 0 && lookY === 0) return;
      lookTravel += Math.abs(lookX) + Math.abs(lookY);
      if (lookTravel > LOOK_CLICK_SLOP_PX) lock.request();
      apply(flyLook(pose(), lookX, lookY));
    },

    wheel(e) {
      e.preventDefault();
      const steps = wheelStep(e.deltaY, e.deltaMode);
      if (steps !== 0) flySpeedStore.setLevel(flySpeedStore.get().level + steps);
    },

    deferContextMenu() {
      if (active) menuDeferred = true;
    },

    consumeMenuSuppression() {
      if (now() >= suppressMenuUntil) return false;
      suppressMenuUntil = -Infinity;
      return true;
    },

    end() {
      if (!active) return 'none';
      stop();
      const wasHeld = now() - pressedAt >= HOLD_TO_FLY_MS;
      if (flew || wasHeld || lookTravel > LOOK_CLICK_SLOP_PX) {
        suppressMenuUntil = now() + MENU_SUPPRESSION_MS;
        return 'flew';
      }
      return menuDeferred ? 'menu' : 'none';
    },

    dispose() {
      active = false;
      stopLoop();
      lock.release();
      keyTarget.removeEventListener('keydown', onKeyDown, true);
      keyTarget.removeEventListener('keyup', onKeyUp, true);
      keyTarget.removeEventListener('blur', onBlur, true);
      document.removeEventListener('visibilitychange', onVisibility);
      if (flySpeedStore.get().active) setFlySpeedState({ active: false });
    },
  };
}
