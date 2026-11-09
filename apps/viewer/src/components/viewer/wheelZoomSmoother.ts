/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delivers 3D wheel zoom over a few frames instead of in one jump (#9507).
 *
 * The step size was never the problem: a notch zooms about 10 %, like
 * MapLibre and Potree. Two things about how it landed were:
 *
 *  - **It jumped.** The whole step landed in one frame. MapLibre eases a
 *    notch over ~200 ms, OpenLayers over 250 ms, camera-controls (ThatOpen)
 *    damps over 0.2-0.25 s, and Potree, model-viewer, Babylon and Cesium all
 *    fade or damp it.
 *  - **Bursts compounded.** The camera caps each EVENT at 10 %, so a fast
 *    spin, a free-spinning wheel or trackpad momentum (dozens of events)
 *    compounded with no budget. MapLibre, deck.gl and Leaflet sum a frame's
 *    deltas and compress them; OpenLayers caps a gesture at one zoom level.
 *
 * So wheel travel goes into a backlog, in the camera's own unit (wheel px,
 * where 100 px is one 10 % notch). The backlog is capped, so no burst can
 * queue more than {@link MAX_BACKLOG_PX} ahead, and drained exponentially
 * (time constant {@link EASE_TAU_MS}), at most one notch per frame. The first
 * slice lands in the event itself, so the response starts in the same frame.
 *
 * Only discrete notches ease. A trackpad or smooth wheel already streams small
 * deltas at frame rate, and easing those adds lag (MapLibre applies trackpad
 * input directly for the same reason). They apply at once, up to one notch per
 * event; anything above that drains like a notch.
 *
 * Reversing direction drops the backlog. Any other camera move (orbit, pan,
 * a preset view, fly) cancels it: the pose after each step is remembered and
 * a different pose at the next step means someone else moved the camera.
 * `prefers-reduced-motion` applies every step at once.
 */

/** Time constant of the drain: ~95 % of a notch lands within 180 ms. */
export const EASE_TAU_MS = 60;
/** At most three notches (~27 %) may be pending: a burst cannot run away. */
export const MAX_BACKLOG_PX = 300;
/** One camera step, and so one frame, moves at most one notch (the camera's own 10 % cap). */
export const MAX_STEP_PX = 100;
/** A remainder this small lands at once instead of trailing off. */
const SETTLE_PX = 0.5;
/** Frame time assumed for the slice that lands in the event itself. */
const FIRST_FRAME_MS = 1000 / 60;
/** A long frame (a tab switch, a GC pause) counts as this much, so the zoom never lurches. */
const MAX_FRAME_MS = 50;
/** Every frame counts as at least a 240 Hz frame, so the ease always ends, even on a frozen clock. */
const MIN_FRAME_MS = 1000 / 240;

export interface WheelZoomAnchor { clientX: number; clientY: number }

export interface WheelZoomInput extends WheelZoomAnchor {
  /** Signed wheel travel in camera units (positive zooms out). */
  px: number;
  /** A discrete notch, eased; false for trackpad / pinch / smooth-wheel streams. */
  eased: boolean;
  /** Shift / Cesium pure dolly for this gesture. */
  fastZoom: boolean;
}

export interface WheelZoomSmootherOptions {
  /** Applies one step of `px` (|px| <= {@link MAX_STEP_PX}) to the camera at `anchor`. */
  step(px: number, anchor: WheelZoomAnchor, fastZoom: boolean): void;
  /** The camera pose, compared between steps to notice another control moving it. */
  poseKey(): string;
  /** After the last step of a zoom, or when a pending zoom is cancelled. */
  onSettle(): void;
  reducedMotion(): boolean;
  now?(): number;
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}

export interface WheelZoomSmoother {
  push(input: WheelZoomInput): void;
  /** Drops any pending zoom. */
  cancel(): void;
  dispose(): void;
  /** Pending travel, in camera units. */
  pending(): number;
}

export function createWheelZoomSmoother(options: WheelZoomSmootherOptions): WheelZoomSmoother {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));

  let backlog = 0;
  let anchor: WheelZoomAnchor = { clientX: 0, clientY: 0 };
  let fastZoom = false;
  let frame: number | null = null;
  let lastTime = 0;
  /** Pose after our last step; null when no zoom is in flight. */
  let expectedPose: string | null = null;
  let disposed = false;

  const stopFrame = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };

  /** Ends the zoom in flight, if any, and reports it once. */
  const settle = () => {
    stopFrame();
    backlog = 0;
    if (expectedPose === null) return;
    expectedPose = null;
    options.onSettle();
  };

  /** True when something other than this smoother moved the camera since our last step. */
  const movedElsewhere = () => expectedPose !== null && options.poseKey() !== expectedPose;

  const apply = (px: number) => {
    const clamped = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, px));
    backlog -= clamped;
    if (Math.abs(backlog) < SETTLE_PX) backlog = 0;
    options.step(clamped, anchor, fastZoom);
    expectedPose = options.poseKey();
  };

  /** One drain step covering `dt` ms of the ease. */
  const drain = (dt: number) => {
    const share = 1 - Math.exp(-Math.min(Math.max(dt, MIN_FRAME_MS), MAX_FRAME_MS) / EASE_TAU_MS);
    const remainder = backlog * (1 - share);
    apply(Math.abs(remainder) < SETTLE_PX ? backlog : backlog * share);
  };

  const schedule = () => {
    if (frame !== null || disposed) return;
    frame = requestFrame(onFrame);
  };

  function onFrame() {
    frame = null;
    if (movedElsewhere()) return settle();
    const t = now();
    drain(t - lastTime);
    lastTime = t;
    if (backlog === 0) return settle();
    schedule();
  }

  return {
    push(input) {
      if (disposed || !Number.isFinite(input.px) || input.px === 0) return;
      if (movedElsewhere()) settle();
      else if (Math.sign(input.px) !== Math.sign(backlog)) backlog = 0; // a reversal drops what was queued
      backlog = Math.max(-MAX_BACKLOG_PX, Math.min(MAX_BACKLOG_PX, backlog + input.px));
      anchor = { clientX: input.clientX, clientY: input.clientY };
      fastZoom = input.fastZoom;

      if (options.reducedMotion()) {
        while (backlog !== 0) apply(backlog);
        return settle();
      }
      // While an ease runs, its frame drains what this event added: a burst of
      // events inside one frame must not each land a slice of their own.
      if (frame !== null) return;
      if (input.eased) drain(FIRST_FRAME_MS);
      else apply(backlog);
      lastTime = now();
      if (backlog === 0) return settle();
      schedule();
    },
    cancel: settle,
    dispose() {
      stopFrame();
      backlog = 0;
      expectedPose = null;
      disposed = true;
    },
    pending: () => backlog,
  };
}
