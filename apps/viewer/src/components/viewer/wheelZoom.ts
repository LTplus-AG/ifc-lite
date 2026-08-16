/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wheel zoom: the step the wheel applies, and the modifier that makes it finer
 * (#2683).
 *
 * QGIS is the reference the request cited. Its map canvas divides the *excess
 * over 1* of the wheel zoom factor by 20 while Ctrl is down, under the comment
 * "holding ctrl while wheel zooming results in a finer zoom"
 * (`QgsMapCanvas::wheelEvent`, src/gui/qgsmapcanvas.cpp), and the user manual
 * says the same. So the convention is FINER, not faster, and it is a change of
 * step size, not of direction.
 *
 * We follow the intent rather than the literal divisor. QGIS' unmodified notch
 * is a 2x jump (100% of the current scale); ours is a tenth of that -- the
 * renderer clamps a notch at `MAX_ZOOM_DELTA` = 0.1, so a wheel notch moves
 * ~10% -- and dividing that by 20 would leave ~0.5% per notch, several hundred
 * notches to halve the view distance. A fifth of the default step lands at ~2%
 * per notch: finer than QGIS' fine zoom in absolute terms, still responsive
 * enough that a flick of the wheel visibly moves.
 *
 * The unmodified wheel is untouched, so existing muscle memory is unchanged.
 */

/** Fraction of the normal wheel step applied while the fine modifier is held. */
export const FINE_ZOOM_STEP_FACTOR = 0.2;

/** The part of `Camera` this module drives. Keeps the unit testable. */
export interface WheelZoomCamera {
  zoom(
    delta: number,
    addVelocity?: boolean,
    mouseX?: number,
    mouseY?: number,
    canvasWidth?: number,
    canvasHeight?: number,
    fastZoom?: boolean,
  ): void;
}

/** The part of a wheel event this module reads. */
export interface WheelZoomEvent {
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
  preventDefault(): void;
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

  target.addEventListener('keydown', onKey);
  target.addEventListener('keyup', onKey);
  target.addEventListener('blur', onBlur);

  return {
    isHeld: () => held,
    dispose() {
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('keyup', onKey);
      target.removeEventListener('blur', onBlur);
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

/** Wheel delta to feed the camera: the raw one, or a fraction of it. */
export function wheelZoomDelta(
  e: Pick<WheelZoomEvent, 'deltaY' | 'ctrlKey' | 'metaKey'>,
  modifierKeyHeld: boolean,
): number {
  return isFineZoomWheel(e, modifierKeyHeld) ? e.deltaY * FINE_ZOOM_STEP_FACTOR : e.deltaY;
}

export interface WheelZoomOptions {
  camera: WheelZoomCamera;
  canvas: HTMLCanvasElement;
  /** Shift, or Cesium mode: pure dolly. Orthogonal to the fine step. */
  fastZoom: boolean;
  /** {@link FineZoomModifierTracker.isHeld} at the time of the event. */
  fineModifierHeld: boolean;
}

/**
 * Applies one wheel notch to the camera, anchored at the cursor.
 *
 * `preventDefault` is unconditional and comes first. Ctrl+wheel is the
 * browser's own page-zoom shortcut (and its pinch-zoom gesture), so without it
 * the fine-zoom modifier would scale the whole page instead of the model. It
 * only takes effect because the listener is registered with
 * `{ passive: false }` in `useMouseControls`; a passive listener cannot cancel
 * the default and the browser would zoom the page regardless.
 */
export function applyWheelZoom(e: WheelZoomEvent, opts: WheelZoomOptions): void {
  e.preventDefault();

  const rect = opts.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  opts.camera.zoom(
    wheelZoomDelta(e, opts.fineModifierHeld),
    false,
    mouseX,
    mouseY,
    opts.canvas.width,
    opts.canvas.height,
    opts.fastZoom,
  );
}
