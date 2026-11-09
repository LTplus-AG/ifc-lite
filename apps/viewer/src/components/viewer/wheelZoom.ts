/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wheel zoom: how a wheel event becomes zoom input, the modifier that makes it
 * finer (#2683), and the controller that feeds it through the smoother
 * (`lib/navigation/wheel-zoom-smoother.ts`, #9507) into the 3D camera or a 2D
 * view transform.
 *
 * QGIS is the reference the fine-zoom request cited. Its map canvas divides
 * the *excess over 1* of the wheel zoom factor by 20 while Ctrl is down, under
 * the comment "holding ctrl while wheel zooming results in a finer zoom"
 * (`QgsMapCanvas::wheelEvent`, src/gui/qgsmapcanvas.cpp), and the user manual
 * says the same. So the convention is FINER, not faster, and it is a change of
 * step size, not of direction.
 *
 * We follow the intent rather than the literal divisor. QGIS' unmodified notch
 * is a 2x jump (100% of the current scale); ours is a tenth of that -- a
 * notch moves ~10% -- and dividing that by 20 would leave ~0.5% per notch,
 * several hundred notches to halve the view distance. A fifth of the default
 * step lands at ~2% per notch: finer than QGIS' fine zoom in absolute terms,
 * still responsive enough that a flick of the wheel visibly moves.
 */

import { cameraPoseKey, SURFACE_PICK_IDLE_MS, type SurfacePoint, type SurfaceZoomCamera, type ZoomSurfacePicker } from './zoomSurface.js';
import { WHEEL_NOTCH_MIN_PX, wheelDeltaPx, wheelZoomScale } from '@/lib/navigation/wheel-input.js';
import { createWheelZoomSmoother, MAX_STEP_PX, type WheelZoomAnchor } from '@/lib/navigation/wheel-zoom-smoother.js';

/** Fraction of the normal wheel step applied while the fine modifier is held. */
export const FINE_ZOOM_STEP_FACTOR = 0.2;

/** The part of a wheel event this module reads. */
export interface WheelZoomEvent {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
}

/**
 * Tracks whether Ctrl or Cmd is PHYSICALLY held, from keyboard events.
 *
 * A wheel event's own `ctrlKey` cannot answer that question. Browsers
 * synthesise a wheel event with `ctrlKey: true` for a trackpad pinch -- macOS
 * is the familiar case, but Chromium does it for precision touchpads on
 * Windows and Linux too -- and no keyboard event accompanies it. Reading
 * `e.ctrlKey` alone would therefore hand every pinch-zoom the fine step, which
 * is exactly the gesture users expect to move the camera at full speed.
 *
 * Keyboard events do not lie: they only fire for real key presses, and every
 * one of them reports the true modifier state, so `keydown` for Ctrl (which
 * itself carries `ctrlKey: true`) opens the gate and its `keyup` closes it.
 * That is why the modifier is Ctrl *and* Cmd on every platform rather than a
 * per-platform mapping: with a real key press required, Ctrl means Ctrl on a
 * Mac as well, which is what the request asked for, and Cmd is accepted
 * alongside it because that is the modifier Mac users reach for.
 *
 * Focus can be lost with the key down (Ctrl+Tab, a Space switch), which would
 * leave the flag stuck on; `blur` resets it, and {@link isFineZoomWheel} also
 * requires the wheel event to agree, so a stale flag alone can never engage
 * the fine step. The mirror case is a key already down when the tracker is
 * created, which no keyboard event announces: the fine step then waits for the
 * next press. The viewport mounts once at startup, well before anyone reaches
 * for Ctrl, so that costs at most the very first gesture of a session.
 */
export interface FineZoomModifierTracker {
  /** True while Ctrl or Cmd is held, as witnessed by a keyboard event. */
  isHeld(): boolean;
  dispose(): void;
}

export function createFineZoomModifierTracker(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): FineZoomModifierTracker {
  let held = false;

  const onKey = (e: Event) => {
    const ke = e as KeyboardEvent;
    held = ke.ctrlKey || ke.metaKey;
  };
  const onBlur = () => {
    held = false;
  };

  // CAPTURE phase, deliberately. Focused editors in this app stop key events
  // from bubbling -- `TextAnnotationEditor.tsx:63` calls `e.stopPropagation()`
  // on every keydown so the canvas does not act on typing. A bubble-phase
  // listener on `window` therefore never sees the physical Ctrl press while
  // such an editor holds focus, and the next wheel gesture over the canvas
  // would silently use the normal step. Capture runs window-first, before any
  // child can stop propagation, so the tracker observes the key regardless of
  // what is focused. The removals must pass the SAME option or they do not
  // match the registration and the listeners leak.
  target.addEventListener('keydown', onKey, true);
  target.addEventListener('keyup', onKey, true);
  target.addEventListener('blur', onBlur, true);

  return {
    isHeld: () => held,
    dispose() {
      target.removeEventListener('keydown', onKey, true);
      target.removeEventListener('keyup', onKey, true);
      target.removeEventListener('blur', onBlur, true);
    },
  };
}

/**
 * Does this wheel event carry the fine-zoom modifier?
 *
 * Both halves are required: the keyboard must have witnessed a real Ctrl/Cmd
 * press (so a synthesised pinch cannot pass) and the wheel event must still
 * report the modifier down (so a flag stranded by a lost `keyup` cannot).
 */
export function isFineZoomWheel(
  e: Pick<WheelZoomEvent, 'ctrlKey' | 'metaKey'>,
  modifierKeyHeld: boolean,
): boolean {
  return modifierKeyHeld && (e.ctrlKey || e.metaKey);
}

/**
 * The zoom input a wheel event carries, in camera units (wheel px, positive
 * zooms out): `deltaY` in CSS px whatever its `deltaMode`, times the fine
 * factor when the modifier is really held, times the sensitivity setting.
 *
 * `eased` marks a discrete notch. A pinch (`ctrlKey` with no key held) and the
 * small deltas a trackpad or smooth wheel streams are continuous input, which
 * already arrives at frame rate and would only lag if eased.
 */
export function wheelZoomInput(
  e: Pick<WheelZoomEvent, 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey'>,
  modifierKeyHeld: boolean,
  sensitivity: number,
  /** CSS px per page for a page-mode delta: the view's height. */
  pagePx?: number,
): { px: number; eased: boolean } {
  const raw = wheelDeltaPx(e.deltaY, e.deltaMode, pagePx);
  const fine = isFineZoomWheel(e, modifierKeyHeld);
  const pinch = e.ctrlKey && !fine;
  const eased = !pinch && Math.abs(raw) >= WHEEL_NOTCH_MIN_PX;
  // A notch is at most one camera notch (~10 %), as the camera's per-call cap
  // made it before the smoother split notches into smaller steps: Chromium
  // reports 120 or, on a HiDPI screen, 150 px for the same notch.
  const travel = eased ? Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, raw)) : raw;
  return { px: travel * (fine ? FINE_ZOOM_STEP_FACTOR : 1) * sensitivity, eased };
}

export interface WheelZoomStepOptions {
  /** The pose is read back after each step so a cached surface point is only
   *  reused while nothing but the surface zoom has moved the camera (#5393). */
  camera: SurfaceZoomCamera;
  canvas: HTMLCanvasElement;
  /** Shift, or Cesium mode: pure dolly. Orthogonal to the fine step. */
  fastZoom: boolean;
  /**
   * The visible surface under a canvas point, in CSS px (#5393), e.g. the
   * renderer's `raycastScene(...).intersection.point`. When given, zooming IN
   * approaches that surface and stops short of it instead of passing through
   * thin objects; null (empty space) keeps the plain zoom.
   */
  pickSurface?: ZoomSurfacePicker;
}

/**
 * One pick per wheel GESTURE, not per notch (#5393). A gesture is a run of
 * wheel events with the cursor held within {@link SURFACE_GESTURE_SLOP_PX}
 * and no pause over {@link SURFACE_PICK_IDLE_MS}. The surface zoom moves
 * the camera along the cursor ray, so the picked point stays under the cursor
 * and stays valid for the rest of the gesture. It is valid ONLY while the
 * surface zoom is the sole thing moving the camera: the pose
 * ({@link cameraPoseKey}) after each notch is recorded, and any other move in
 * between (a fast-zoom dolly, an orbit, a pan, a look-around, a key) takes the
 * point off the cursor ray, so the next notch re-picks.
 */
const SURFACE_GESTURE_SLOP_PX = 4;
interface SurfaceGesture { x: number; y: number; at: number; point: SurfacePoint | null; pose: string }
const surfaceGestures = new WeakMap<object, SurfaceGesture>();

function gestureSurface(opts: WheelZoomStepOptions, mouseX: number, mouseY: number): SurfaceGesture | null {
  const pick = opts.pickSurface;
  if (!pick) return null;
  const now = Date.now();
  const g = surfaceGestures.get(opts.canvas);
  if (g && now - g.at < SURFACE_PICK_IDLE_MS && g.pose === cameraPoseKey(opts.camera)
    && Math.abs(g.x - mouseX) <= SURFACE_GESTURE_SLOP_PX && Math.abs(g.y - mouseY) <= SURFACE_GESTURE_SLOP_PX) {
    g.at = now;
    // A depth-probe pick (#8769) is cheap and sharpens as the camera nears, so
    // it re-picks every notch; a miss (no answer yet) keeps the known point.
    if (pick.live?.()) g.point = pick(mouseX, mouseY) ?? g.point;
    return g;
  }
  const fresh: SurfaceGesture = { x: mouseX, y: mouseY, at: now, point: pick(mouseX, mouseY), pose: '' };
  surfaceGestures.set(opts.canvas, fresh);
  return fresh;
}

/**
 * Applies one zoom step of `px` camera units to the camera, anchored at the
 * cursor. The smoother calls this once per frame while a zoom eases.
 *
 * The wheel handler cancels the browser default itself: Ctrl+wheel is the
 * browser's page-zoom shortcut (and its pinch-zoom gesture), which only a
 * `{ passive: false }` listener can stop.
 */
export function applyWheelZoomStep(px: number, anchor: WheelZoomAnchor, opts: WheelZoomStepOptions): void {
  const rect = opts.canvas.getBoundingClientRect();
  const mouseX = anchor.clientX - rect.left;
  const mouseY = anchor.clientY - rect.top;

  // Only zooming in can pass through a surface; zooming out and the fast
  // (pure dolly) zoom keep the plain path and never pick.
  const gesture = px < 0 && !opts.fastZoom ? gestureSurface(opts, mouseX, mouseY) : null;
  const surface = gesture?.point ?? undefined;
  opts.camera.zoom(
    px,
    false,
    mouseX,
    mouseY,
    // The cursor is in CSS px, so the extent must be too. The drawing buffer
    // (`canvas.width`) is in device px and drifted the anchor (#5383).
    rect.width,
    rect.height,
    opts.fastZoom,
    surface,
  );
  if (gesture) gesture.pose = cameraPoseKey(opts.camera);
}

/** Read per gesture, so turning the OS setting on applies without a reload. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

export interface WheelZoomControllerOptions {
  /** Applies one eased step of `px` wheel px at `anchor` (client coordinates). */
  step(px: number, anchor: WheelZoomAnchor, fastZoom: boolean): void;
  /** The view's pose, so a move by any other control cancels a pending zoom. */
  poseKey(): string;
  /** The sensitivity setting's factor, read per event (#9507). */
  sensitivity(): number;
  /** The view's height in CSS px, the size of a page-mode wheel delta. */
  pagePx?(): number;
  /** When a zoom has finished easing, or was cancelled. */
  onSettle?(): void;
  /** Where the fine-zoom modifier's key events are observed. */
  keyTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  reducedMotion?(): boolean;
}

export interface WheelZoomController {
  zoom(e: WheelZoomEvent, fastZoom?: boolean): void;
  dispose(): void;
}

/** Every view's wheel zoom: event → input (fine step, sensitivity) → eased steps (#9507). */
export function createWheelZoomController(opts: WheelZoomControllerOptions): WheelZoomController {
  const modifier = createFineZoomModifierTracker(opts.keyTarget);
  const smoother = createWheelZoomSmoother({
    step: opts.step,
    poseKey: opts.poseKey,
    onSettle: opts.onSettle ?? (() => {}),
    reducedMotion: opts.reducedMotion ?? prefersReducedMotion,
  });
  return {
    zoom(e, fastZoom = false) {
      const input = wheelZoomInput(e, modifier.isHeld(), opts.sensitivity(), opts.pagePx?.());
      smoother.push({ ...input, clientX: e.clientX, clientY: e.clientY, fastZoom });
    },
    dispose() {
      smoother.dispose();
      modifier.dispose();
    },
  };
}

export interface ViewportWheelZoomOptions extends Omit<WheelZoomStepOptions, 'fastZoom'>,
  Pick<WheelZoomControllerOptions, 'sensitivity' | 'onSettle' | 'keyTarget' | 'reducedMotion'> {
  /** After every camera step. */
  onStep(): void;
}

/** The 3D viewport's wheel zoom: eased, cursor-anchored, surface-aware camera steps. */
export function createViewportWheelZoom(opts: ViewportWheelZoomOptions): WheelZoomController {
  return createWheelZoomController({
    ...opts,
    step: (px, anchor, fastZoom) => {
      applyWheelZoomStep(px, anchor, { camera: opts.camera, canvas: opts.canvas, fastZoom, pickSurface: opts.pickSurface });
      opts.onStep();
    },
    poseKey: () => cameraPoseKey(opts.camera),
    pagePx: () => opts.canvas.getBoundingClientRect().height,
  });
}

export interface TransformWheelZoomOptions<T> extends Pick<WheelZoomControllerOptions, 'sensitivity' | 'keyTarget' | 'reducedMotion'> {
  /** The view's current transform; null while there is none to zoom. */
  get(): T | null;
  /** Writes the zoomed transform. */
  set(next: T): void;
  /** `t` zoomed by `scale` about canvas point `(x, y)`; null refuses the step. */
  zoomAbout(t: T, scale: number, x: number, y: number): T | null;
  /** The canvas box the anchor (and a page-mode delta) is measured in. */
  rect(): Pick<DOMRect, 'left' | 'top' | 'height'>;
}

/** A 2D view's wheel zoom (drawing, plan): the same eased steps on a scale/offset transform. */
export function createTransformWheelZoom<T>(opts: TransformWheelZoomOptions<T>): WheelZoomController {
  return createWheelZoomController({
    ...opts,
    step: (px, anchor) => {
      const current = opts.get();
      if (!current) return;
      const rect = opts.rect();
      const next = opts.zoomAbout(current, wheelZoomScale(px), anchor.clientX - rect.left, anchor.clientY - rect.top);
      if (next) opts.set(next);
    },
    poseKey: () => JSON.stringify(opts.get()),
    pagePx: () => opts.rect().height,
  });
}
