/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly navigation maths (Unreal-editor style): hold the right mouse button,
 * move the mouse to look around the camera's own position, WASD to fly, E/Q
 * to rise/sink, wheel to change the fly speed.
 *
 * Pure functions over a `{ position, target }` pose so the behaviour is
 * testable without a canvas; `flyControls.ts` owns the DOM and the camera.
 * World is Y-up (the viewer converts IFC Z-up during mesh parsing).
 */

export interface Vec3 { x: number; y: number; z: number }
export interface FlyPose { position: Vec3; target: Vec3 }

/** Radians of look rotation per pixel of mouse travel. */
export const FLY_LOOK_SENSITIVITY = 0.004;

/** Keeps the look direction just off straight up/down, where yaw is undefined. */
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Speed multipliers the wheel steps through, slowest first. Mirrors Unreal's
 * eight camera-speed settings: a notch is a clear change, and the extremes
 * cover both nudging through a doorway and crossing a site.
 */
export const FLY_SPEED_LEVELS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16] as const;
export const DEFAULT_FLY_SPEED_LEVEL = 3;

/** Held Shift multiplies the current speed, like walk mode's sprint. */
export const FLY_SPRINT_FACTOR = 3;

/**
 * Held Alt divides it, for creeping through an interior — the mirror of the
 * sprint, and Alt rather than Ctrl on purpose: Chrome and Edge reserve Ctrl+W
 * for "close tab" and a page cannot cancel it, so a Ctrl precision modifier
 * would close the viewer, and the model with it, on the most-used fly key.
 */
export const FLY_PRECISION_FACTOR = 1 / 3;

/**
 * Accumulated wheel travel, in pixels, for one speed step. A mouse-wheel notch
 * reports 100-120 depending on the platform; a trackpad reports many small
 * deltas that add up to the same.
 */
const WHEEL_STEP_PX = 100;
/** A single event at least this large is one discrete notch: exactly one step. */
const WHEEL_NOTCH_MIN_PX = 40;
/** Pixels per line for `deltaMode === 1` (Firefox reports line deltas for a wheel). */
const WHEEL_LINE_PX = 33;

const isFiniteVec = (v: Vec3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * Rotate the look direction around the camera position. The position never
 * moves; the target stays at its current distance so an orbit after leaving
 * fly mode still pivots at a sensible depth.
 *
 * Mouse right turns right, mouse up looks up. Returns `null` for a pose or
 * delta that would produce a non-finite result, so a malformed input leaves
 * the camera untouched instead of poisoning it.
 */
export function flyLook(pose: FlyPose, dx: number, dy: number, sensitivity = FLY_LOOK_SENSITIVITY): FlyPose | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (!isFiniteVec(pose.position) || !isFiniteVec(pose.target)) return null;
  const lx = pose.target.x - pose.position.x;
  const ly = pose.target.y - pose.position.y;
  const lz = pose.target.z - pose.position.z;
  const dist = Math.hypot(lx, ly, lz);
  if (dist < 1e-9) return null;

  const yaw = Math.atan2(lx, lz) - dx * sensitivity;
  const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.asin(ly / dist) - dy * sensitivity));
  const cp = Math.cos(pitch);
  return {
    position: { ...pose.position },
    target: {
      x: pose.position.x + Math.sin(yaw) * cp * dist,
      y: pose.position.y + Math.sin(pitch) * dist,
      z: pose.position.z + Math.cos(yaw) * cp * dist,
    },
  };
}

/** Movement intent, each axis in [-1, 1]: forward (W/S), right (D/A), up (E/Q). */
export interface FlyInput { forward: number; right: number; up: number }

/**
 * World-space velocity direction for an input. Forward follows the full look
 * direction (pitch included, so W flies where you look); right is horizontal;
 * up is world Y. Diagonals are normalised so W+D is not faster than W.
 */
export function flyDirection(pose: FlyPose, input: FlyInput): Vec3 {
  const lx = pose.target.x - pose.position.x;
  const ly = pose.target.y - pose.position.y;
  const lz = pose.target.z - pose.position.z;
  const len = Math.hypot(lx, ly, lz);
  const horiz = Math.hypot(lx, lz);
  if (!(len > 1e-9) || !(horiz > 1e-9)) return { x: 0, y: input.up, z: 0 };
  const fx = lx / len, fy = ly / len, fz = lz / len;
  const rx = -lz / horiz, rz = lx / horiz;
  const v = {
    x: fx * input.forward + rx * input.right,
    y: fy * input.forward + input.up,
    z: fz * input.forward + rz * input.right,
  };
  const mag = Math.hypot(v.x, v.y, v.z);
  return mag > 1 ? { x: v.x / mag, y: v.y / mag, z: v.z / mag } : v;
}

/** Translate position and target together (the view direction is preserved). */
export function flyTranslate(pose: FlyPose, offset: Vec3): FlyPose | null {
  if (!isFiniteVec(offset)) return null;
  const add = (p: Vec3): Vec3 => ({ x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z });
  const next = { position: add(pose.position), target: add(pose.target) };
  return isFiniteVec(next.position) && isFiniteVec(next.target) ? next : null;
}

/**
 * Base fly speed in world units per second at the 1x level, scaled to the
 * scene so a house and a campus both feel navigable: a twentieth of the scene
 * diagonal per second, floored/capped to stay usable on degenerate bounds.
 *
 * The factor was halved from a tenth after the first round of use: walking an
 * interior at the slowest level was still too fast to hold a doorway, which is
 * the case the bottom of the range exists for.
 */
export function baseFlySpeed(bounds: { min: Vec3; max: Vec3 } | null): number {
  if (!bounds || !isFiniteVec(bounds.min) || !isFiniteVec(bounds.max)) return 1;
  const diag = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
  return Math.max(0.25, Math.min(250, diag * 0.05));
}

/**
 * Accumulates wheel deltas into whole speed steps. Scrolling up (negative
 * deltaY) is faster. A notch-sized event is always exactly one step, however
 * the platform scales it; small trackpad deltas accumulate until they add up
 * to a notch, and the remainder carries over.
 */
export function createWheelStepper(): (deltaY: number, deltaMode: number) => number {
  let acc = 0;
  return (deltaY, deltaMode) => {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    const px = deltaMode === 0 ? deltaY : deltaY * WHEEL_LINE_PX;
    if (Math.abs(px) >= WHEEL_NOTCH_MIN_PX) {
      acc = 0;
      return px < 0 ? 1 : -1;
    }
    acc += px;
    const steps = Math.trunc(acc / WHEEL_STEP_PX);
    acc -= steps * WHEEL_STEP_PX;
    return -steps;
  };
}

export function clampFlySpeedLevel(level: number): number {
  return Math.max(0, Math.min(FLY_SPEED_LEVELS.length - 1, Math.round(level)));
}
