/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orthographic fidelity score (#9501): a deterministic scoreboard for the
 * camera paths that put an orthographic view on an axis, meant to be driven
 * down to zero and kept there.
 *
 * The scene is the joint from #9501 in viewer space (Y up, metres): a
 * 200x200x10 SHS column 1.3 m tall, a 45 degree brace in the X/Y plane and a
 * gusset plate between them. Every case runs the real `Camera` (preset tween,
 * orbit, pan, zoom, `setRotation`) and projects the scene with the matrices
 * it would render with.
 *
 * Metrics, all "lower is better" and all zero on a correct camera:
 *  - `smearPx`: on-screen length of the scene's edges that run along the view
 *    axis. In orthographic projection an axis view draws them as points; any
 *    length is a wall drawn beside its section (the band in #9501).
 *  - `upErrorDeg`: angle between the compass direction a preset promises at
 *    the top of the screen and the one drawn.
 *  - `angleErrorDeg`: `getRotation` against the angles the case asked for.
 *  - `orbitJumpDeg`: screen rotation caused by a 1 px horizontal drag from an
 *    axis view (a drag that small must not visibly re-orient the screen).
 *  - `tiltErrorDeg`: angle between the way a vertical drag off a plan tilts
 *    the camera and the way the screen says it should (towards the face at
 *    the bottom of the screen).
 *  - `offscreen`: scene corners outside the viewport after a preset.
 *
 * `scoreOrthoFidelity()` returns every case; `summarize` folds them into
 * one score. `camera-ortho-fidelity.test.ts` pins it at zero and prints the
 * table with `ORTHO_FIDELITY_REPORT=1`.
 */

import { Camera } from '../camera.js';
import { CAMERA_CONSTANTS } from '../constants.js';
import type { Vec3 } from '../types.js';

export type PresetView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** An axis-aligned or oriented box: centre, three half-axes (world vectors). */
interface Box { name: string; center: Vec3; axes: [Vec3, Vec3, Vec3] }

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a: Vec3, s: number): Vec3 => v(a.x * s, a.y * s, a.z * s);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => scale(a, 1 / len(a));
const deg = (rad: number): number => (rad * 180) / Math.PI;

const S = Math.SQRT1_2;

/** The #9501 joint. Column walls are separate boxes so the hollow section is real. */
export const JOINT: readonly Box[] = [
  { name: 'column wall +x', center: v(0.095, 0.65, 0), axes: [v(0.005, 0, 0), v(0, 0.65, 0), v(0, 0, 0.1)] },
  { name: 'column wall -x', center: v(-0.095, 0.65, 0), axes: [v(0.005, 0, 0), v(0, 0.65, 0), v(0, 0, 0.1)] },
  { name: 'column wall +z', center: v(0, 0.65, 0.095), axes: [v(0.09, 0, 0), v(0, 0.65, 0), v(0, 0, 0.005)] },
  { name: 'column wall -z', center: v(0, 0.65, -0.095), axes: [v(0.09, 0, 0), v(0, 0.65, 0), v(0, 0, 0.005)] },
  { name: 'gusset', center: v(0.3, 0.55, 0), axes: [v(0.25, 0, 0), v(0, 0.2, 0), v(0, 0, 0.005)] },
  // 45 degrees in X/Y, 1 m long, 120x120 section.
  { name: 'brace', center: v(0.75, 0.9, 0), axes: [v(0.5 * S, 0.5 * S, 0), v(-0.06 * S, 0.06 * S, 0), v(0, 0, 0.06)] },
];

const corners = (box: Box): Vec3[] => {
  const out: Vec3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
    out.push(add(box.center, add(scale(box.axes[0], a), add(scale(box.axes[1], b), scale(box.axes[2], c)))));
  }
  return out;
};

export function sceneBounds(boxes: readonly Box[] = JOINT): { min: Vec3; max: Vec3 } {
  const all = boxes.flatMap(corners);
  return {
    min: v(Math.min(...all.map(p => p.x)), Math.min(...all.map(p => p.y)), Math.min(...all.map(p => p.z))),
    max: v(Math.max(...all.map(p => p.x)), Math.max(...all.map(p => p.y)), Math.max(...all.map(p => p.z))),
  };
}

export const VIEWPORT = { width: 1200, height: 600 } as const;

/** Direction from the target to the camera for each preset (Y up, +Z front). */
export const PRESET_AXIS: Record<PresetView, Vec3> = {
  top: v(0, 1, 0), bottom: v(0, -1, 0), front: v(0, 0, 1), back: v(0, 0, -1), left: v(-1, 0, 0), right: v(1, 0, 0),
};

/** World direction at the top of the screen after `rotation` repeat clicks. */
export function presetScreenUp(view: PresetView, rotation: number): Vec3 {
  if (view === 'top') return [v(0, 0, -1), v(-1, 0, 0), v(0, 0, 1), v(1, 0, 0)][rotation]!;
  if (view === 'bottom') return [v(0, 0, -1), v(1, 0, 0), v(0, 0, 1), v(-1, 0, 0)][rotation]!;
  return v(0, 1, 0);
}

/** `getRotation` a preset should report, in degrees. */
export function presetAngles(view: PresetView, rotation: number): { azimuth: number; elevation: number } {
  if (view === 'top') return { azimuth: [0, 90, 180, 270][rotation]!, elevation: 90 };
  if (view === 'bottom') return { azimuth: [180, 90, 0, 270][rotation]!, elevation: -90 };
  const azimuth = { front: 0, back: 180, left: 270, right: 90 }[view];
  return { azimuth, elevation: 0 };
}

/** Run a camera tween to completion on a fake clock (no rAF under node). */
export function settle(camera: Camera, start: () => void): void {
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;
  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);
  try {
    start();
    now += 1_000;
    camera.update(0);
  } finally {
    Date.now = originalNow;
    if (hadRaf) Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
}

export function orthoCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(VIEWPORT.width / VIEWPORT.height);
  camera.setSceneBounds(sceneBounds());
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(0.8);
  return camera;
}

/** Click a preset `rotation + 1` times, the way the ViewCube cycles it. */
export function applyPreset(camera: Camera, view: PresetView, rotation: number): void {
  for (let i = 0; i <= rotation; i++) settle(camera, () => camera.setPresetView(view, sceneBounds()));
}

const project = (camera: Camera, p: Vec3) => camera.projectToScreen(p, VIEWPORT.width, VIEWPORT.height);

/** Longest on-screen edge among the scene's edges parallel to `axis`, in px. */
export function smearPx(camera: Camera, axis: Vec3): number {
  let worst = 0;
  for (const box of JOINT) {
    const along = box.axes.find(a => Math.abs(dot(unit(a), axis)) > 1 - 1e-9);
    if (!along) continue;
    const others = box.axes.filter(a => a !== along);
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const mid = add(box.center, add(scale(others[0]!, a), scale(others[1]!, b)));
      const p = project(camera, add(mid, along));
      const q = project(camera, sub(mid, along));
      if (!p || !q) return Infinity;
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
    }
  }
  return worst;
}

/** World direction drawn at the top of the screen, from the projected motion of a probe. */
function drawnScreenUp(camera: Camera, axis: Vec3): Vec3 {
  const t = camera.getTarget();
  const o = project(camera, t)!;
  let best = v(0, 0, 0);
  let bestUp = -Infinity;
  for (const c of [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)]) {
    if (Math.abs(dot(c, axis)) > 0.5) continue;
    const p = project(camera, add(t, scale(c, 0.1)))!;
    const up = o.y - p.y; // screen y grows downwards
    if (up > bestUp) { bestUp = up; best = c; }
  }
  return best;
}

/** Signed screen rotation (degrees) of the world direction `d` between two frames. */
function screenAngle(camera: Camera, d: Vec3): number {
  const t = camera.getTarget();
  const o = project(camera, t)!;
  const p = project(camera, add(t, scale(d, 0.1)))!;
  return Math.atan2(p.y - o.y, p.x - o.x);
}

function wrapDeg(d: number): number {
  return Math.abs(((d + 540) % 360) - 180);
}

export interface FidelityCase {
  name: string;
  smearPx: number;
  upErrorDeg: number;
  angleErrorDeg: number;
  orbitJumpDeg: number;
  tiltErrorDeg: number;
  offscreen: number;
}

const blank = (name: string): FidelityCase => ({
  name, smearPx: 0, upErrorDeg: 0, angleErrorDeg: 0, orbitJumpDeg: 0, tiltErrorDeg: 0, offscreen: 0,
});

function presetCase(view: PresetView, rotation: number): FidelityCase {
  const camera = orthoCamera();
  // Start from the load pose so the tween has somewhere to come from.
  camera.setPosition(3, 3, 3);
  camera.setTarget(0.4, 0.6, 0);
  applyPreset(camera, view, rotation);
  const c = blank(`preset ${view} #${rotation}`);
  const axis = PRESET_AXIS[view];
  c.smearPx = smearPx(camera, axis);
  const drawn = drawnScreenUp(camera, axis);
  c.upErrorDeg = deg(Math.acos(Math.max(-1, Math.min(1, dot(drawn, presetScreenUp(view, rotation))))));
  const want = presetAngles(view, rotation);
  const got = camera.getRotation();
  c.angleErrorDeg = Math.max(Math.abs(got.elevation - want.elevation), wrapDeg(got.azimuth - want.azimuth));
  for (const p of JOINT.flatMap(corners)) {
    const s = project(camera, p);
    if (!s || s.x < 0 || s.x > VIEWPORT.width || s.y < 0 || s.y > VIEWPORT.height) c.offscreen++;
  }
  return c;
}

/** Orbit off a plan or soffit preset: a tiny drag must not jump, a vertical one tilts towards the screen's bottom face. */
function orbitCase(view: 'top' | 'bottom', rotation: number): FidelityCase {
  const c = blank(`orbit off ${view} #${rotation}`);
  const camera = orthoCamera();
  applyPreset(camera, view, rotation);
  const probe = presetScreenUp(view, rotation);
  const before = screenAngle(camera, probe);
  camera.orbit(1, 0);
  // A 1 px drag turns the plan by ORBIT_SENSITIVITY; any more is a snap.
  c.orbitJumpDeg = Math.max(0, wrapDeg(deg(screenAngle(camera, probe) - before)) - deg(CAMERA_CONSTANTS.ORBIT_SENSITIVITY));

  const tilted = orthoCamera();
  applyPreset(tilted, view, rotation);
  tilted.orbit(0, view === 'top' ? -60 : 60);
  const offset = sub(tilted.getPosition(), tilted.getTarget());
  const horizontal = v(offset.x, 0, offset.z);
  // The camera moves over the face at the bottom of the screen, i.e. away from screen-up.
  const wantDir = view === 'top' ? scale(probe, -1) : probe;
  c.tiltErrorDeg = len(horizontal) < 1e-9 ? 180 : deg(Math.acos(Math.max(-1, Math.min(1, dot(unit(horizontal), wantDir)))));
  return c;
}

/**
 * Orbit off an exact plan pose that did not come from a preset: a plan BCF
 * viewpoint or a horizontal section's "Set view" (`up` horizontal, the camera
 * straight above the target).
 */
function viewpointOrbitCase(up: Vec3): FidelityCase {
  const c = blank(`orbit off plan viewpoint up ${up.x},${up.z}`);
  const make = () => {
    const camera = orthoCamera();
    camera.setTarget(0.4, 0.6, 0);
    camera.setPosition(0.4, 5.6, 0);
    camera.setUp(up.x, up.y, up.z);
    return camera;
  };
  const camera = make();
  const before = screenAngle(camera, up);
  camera.orbit(1, 0);
  c.orbitJumpDeg = Math.max(0, wrapDeg(deg(screenAngle(camera, up) - before)) - deg(CAMERA_CONSTANTS.ORBIT_SENSITIVITY));
  const tilted = make();
  tilted.orbit(0, -60);
  const offset = sub(tilted.getPosition(), tilted.getTarget());
  const horizontal = v(offset.x, 0, offset.z);
  c.tiltErrorDeg = len(horizontal) < 1e-9 ? 180 : deg(Math.acos(Math.max(-1, Math.min(1, dot(unit(horizontal), scale(up, -1))))));
  return c;
}

/** First-person W on a plan walks toward the screen's top (it used to stand still). */
function firstPersonCase(rotation: number): FidelityCase {
  const c = blank(`first-person W on top #${rotation}`);
  const camera = orthoCamera();
  applyPreset(camera, 'top', rotation);
  camera.enableFirstPersonMode(true);
  const before = camera.getPosition();
  for (let i = 0; i < 10; i++) camera.moveFirstPerson(1, 0, 0);
  const moved = sub(camera.getPosition(), before);
  const flat = v(moved.x, 0, moved.z);
  c.tiltErrorDeg = len(flat) < 1e-9 ? 180
    : deg(Math.acos(Math.max(-1, Math.min(1, dot(unit(flat), presetScreenUp('top', rotation))))));
  return c;
}

/**
 * `getRotation` through the tween into a plan or soffit view: the ViewCube
 * reads it every frame, so the azimuth must neither jump to the end value on
 * the first frame nor flip on the last. `angleErrorDeg` is the largest
 * frame-to-frame azimuth step, beyond what a smooth 300 ms turn takes.
 */
function tweenCase(from: Vec3, view: 'top' | 'bottom'): FidelityCase {
  const c = blank(`tween ${from.x},${from.y},${from.z} -> ${view}`);
  const camera = orthoCamera();
  camera.setTarget(0.4, 0.6, 0);
  camera.setPosition(0.4 + from.x, 0.6 + from.y, from.z);
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;
  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);
  try {
    // From the pose before the tween, so a jump on its first frame counts.
    let last: number | null = camera.getRotation().azimuth;
    camera.setPresetView(view, sceneBounds());
    for (let i = 0; i <= 60; i++) {
      now += 6;
      camera.update(0);
      const r = camera.getRotation();
      if (last !== null) c.angleErrorDeg = Math.max(c.angleErrorDeg, wrapDeg(r.azimuth - last));
      last = r.azimuth;
    }
  } finally {
    Date.now = originalNow;
    if (hadRaf) Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
  // A smooth approach turns by at most 26.2 degrees per 6 ms frame (an
  // isometric start re-orients by 135 degrees near the pole; main's camera
  // measured 24.1); every other start stays under 11. A jump to the end
  // azimuth reads 65 or more here, a flip 150-180.
  c.angleErrorDeg = Math.max(0, c.angleErrorDeg - 28);
  return c;
}

/**
 * A pose just off the pole whose `up` is not orthogonal to the view (a BCF
 * viewpoint from another tool): the first drag keeps the screen orientation
 * the frame was drawn with, not the raw `up`'s horizontal part.
 */
function skewedUpCase(): FidelityCase {
  const c = blank('orbit off skewed-up near-plan');
  const camera = orthoCamera();
  camera.setTarget(0.4, 0.6, 0);
  camera.setPosition(0.4, 0.6 + 5 * Math.cos(0.005), 5 * Math.sin(0.005));
  camera.setUp(0.001, 1, 0);
  const probe = v(0, 0, -1);
  const before = screenAngle(camera, probe);
  camera.orbit(1, 0);
  c.orbitJumpDeg = Math.max(0, wrapDeg(deg(screenAngle(camera, probe) - before)) - deg(CAMERA_CONSTANTS.ORBIT_SENSITIVITY));
  return c;
}

/** Pan and zoom on a plan keep it a plan. */
function navigateCase(view: 'top' | 'bottom', what: 'pan' | 'zoom'): FidelityCase {
  const c = blank(`${what} on ${view}`);
  const camera = orthoCamera();
  applyPreset(camera, view, 1);
  if (what === 'pan') camera.pan(40, -25);
  else camera.zoom(-200, false, 900, 150, VIEWPORT.width, VIEWPORT.height);
  c.smearPx = smearPx(camera, PRESET_AXIS[view]);
  const drawn = drawnScreenUp(camera, PRESET_AXIS[view]);
  c.upErrorDeg = deg(Math.acos(Math.max(-1, Math.min(1, dot(drawn, presetScreenUp(view, 1))))));
  return c;
}

/** `setRotation` to straight down/up, as the embed API's SET_CAMERA does. */
function absoluteCase(azimuth: number, elevation: 90 | -90): FidelityCase {
  const c = blank(`setRotation ${azimuth}/${elevation}`);
  const camera = orthoCamera();
  camera.setRotation(azimuth, elevation);
  c.smearPx = smearPx(camera, v(0, Math.sign(elevation), 0));
  const got = camera.getRotation();
  c.angleErrorDeg = Math.max(Math.abs(got.elevation - elevation), wrapDeg(got.azimuth - azimuth));
  return c;
}

export function scoreOrthoFidelity(): FidelityCase[] {
  const cases: FidelityCase[] = [];
  for (const view of Object.keys(PRESET_AXIS) as PresetView[]) {
    for (let rotation = 0; rotation < 4; rotation++) {
      if (view !== 'top' && view !== 'bottom' && rotation > 0) continue;
      cases.push(presetCase(view, rotation));
    }
  }
  for (const view of ['top', 'bottom'] as const) {
    for (let rotation = 0; rotation < 4; rotation++) cases.push(orbitCase(view, rotation));
    cases.push(navigateCase(view, 'pan'), navigateCase(view, 'zoom'));
  }
  for (const up of [v(1, 0, 0), v(-1, 0, 0), v(0, 0, 1), v(0, 0, -1)]) cases.push(viewpointOrbitCase(up));
  for (let rotation = 0; rotation < 4; rotation++) cases.push(firstPersonCase(rotation));
  // Isometric, left, right and front starts. Back -> top and front -> bottom
  // are left out: their blended up passes exactly through the view direction
  // for a frame, a degenerate basis the tween had before #9501 too.
  for (const from of [v(3, 2.4, 3), v(-3, 0, 0.01), v(3, 0, 0.01), v(0, 0, 3)]) {
    if (from.z !== 3 || from.x !== 0) cases.push(tweenCase(from, 'bottom'));
    cases.push(tweenCase(from, 'top'));
  }
  cases.push(skewedUpCase());
  for (const azimuth of [0, 90, 200]) for (const elevation of [90, -90] as const) cases.push(absoluteCase(azimuth, elevation));
  return cases;
}

export interface FidelitySummary {
  cases: number;
  failing: number;
  maxSmearPx: number;
  maxUpErrorDeg: number;
  maxAngleErrorDeg: number;
  maxOrbitJumpDeg: number;
  maxTiltErrorDeg: number;
  offscreen: number;
  /** Sum of the maxima; 0 is the goal. */
  score: number;
}

/** Tolerances below which a metric counts as met (float noise). */
export const TOLERANCE = { px: 1e-3, deg: 1e-3 } as const;

export function isFailing(c: FidelityCase): boolean {
  return c.smearPx > TOLERANCE.px || c.upErrorDeg > TOLERANCE.deg || c.angleErrorDeg > TOLERANCE.deg
    || c.orbitJumpDeg > TOLERANCE.deg || c.tiltErrorDeg > TOLERANCE.deg || c.offscreen > 0;
}

export function summarize(cases: readonly FidelityCase[]): FidelitySummary {
  const max = (k: keyof Omit<FidelityCase, 'name'>) => Math.max(0, ...cases.map(c => c[k]));
  const s = {
    cases: cases.length,
    failing: cases.filter(isFailing).length,
    maxSmearPx: max('smearPx'),
    maxUpErrorDeg: max('upErrorDeg'),
    maxAngleErrorDeg: max('angleErrorDeg'),
    maxOrbitJumpDeg: max('orbitJumpDeg'),
    maxTiltErrorDeg: max('tiltErrorDeg'),
    offscreen: cases.reduce((n, c) => n + c.offscreen, 0),
  };
  return { ...s, score: s.maxSmearPx + s.maxUpErrorDeg + s.maxAngleErrorDeg + s.maxOrbitJumpDeg + s.maxTiltErrorDeg + s.offscreen };
}
