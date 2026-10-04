/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One walk: the capsule stepped at a fixed 120 Hz from frame-rate input, and
 * the eye the camera should sit at.
 *
 * Pure (no DOM, no camera): frames in, eye positions out, so the whole walk —
 * spawn, stairs, falls — runs in a test or the offline large-model benchmark
 * exactly as it runs in the viewer. RvtGo's `Player` is the model for the
 * smoothing: interpolate between physics ticks, ease small vertical jumps
 * (stair risers) while grounded, ease the eye height when crouching.
 */

import {
  WalkCharacter, WALK_CROUCH_EYE, WALK_CROUCH_HEIGHT, WALK_STAND_EYE, WALK_STAND_HEIGHT,
} from './walkCharacter.js';
import type { WalkCollisionWorld } from './walkCollisionWorld.js';

export const WALK_TICK = 1 / 120;
/** At most this many ticks per frame: a long stall resumes instead of fast-forwarding. */
const MAX_TICKS_PER_FRAME = 12;
export const WALK_SPEED = 2.5;
export const RUN_SPEED = 6;
const CROUCH_SPEED = 1.2;
/** Physics off: the walker floats through everything at these speeds, Space / Z for up and down. */
const FLOAT_SPEED = 3;
/** Floor-like contacts only, the same threshold the character uses. */
const FLOOR_NORMAL = 0.7;
/** Down-probes along the line of sight when the view ray itself hits nothing. */
const LINE_OF_SIGHT_SAMPLES = 48;
/** Footprint probes per side for the last-resort spawn. */
const FOOTPRINT_GRID = 16;
/** Radii (m) searched around a spawn spot whose capsule does not fit. */
const FIT_RINGS = [0.35, 0.7, 1.2];
/** How far a spawn spot looks for a wall on each side to count as indoors. */
const ENCLOSURE_REACH = 60;

/** Entry and exit distances of a ray through a box, or null if it misses. */
function rayBox(o: Vec3, dx: number, dy: number, dz: number, b: { min: Vec3; max: Vec3 }): [number, number] | null {
  let near = 0, far = Infinity;
  for (const [oa, da, lo, hi] of [[o.x, dx, b.min.x, b.max.x], [o.y, dy, b.min.y, b.max.y], [o.z, dz, b.min.z, b.max.z]]) {
    if (Math.abs(da) < 1e-12) {
      if (oa < lo || oa > hi) return null;
      continue;
    }
    const t0 = (lo - oa) / da, t1 = (hi - oa) / da;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
  }
  return near <= far ? [near, far] : null;
}

export interface WalkInput {
  forward: number;
  right: number;
  run: boolean;
  jump: boolean;
  crouch: boolean;
}

export interface Vec3 { x: number; y: number; z: number }

export const NO_INPUT: WalkInput = { forward: 0, right: 0, run: false, jump: false, crouch: false };

/** Where a spawn put the walker, for the HUD and the tests. */
export type WalkSpawn = 'floor-below' | 'view-target' | 'ground-plane' | 'free';

export class WalkSession {
  readonly character: WalkCharacter;
  physics = true;
  private accumulator = 0;
  private prevX = 0; private prevY = 0; private prevZ = 0;
  private visualY = 0;
  private eyeHeight = WALK_STAND_EYE;
  private jumpQueued = false;

  constructor(private readonly world: WalkCollisionWorld) {
    this.character = new WalkCharacter(world);
    const b = world.bounds;
    // A fall off the model stops at its lowest point rather than forever.
    this.character.groundY = b ? b.min.y : -Infinity;
  }

  /**
   * Put the walker down near an eye position. Prefers the floor straight below
   * the eye when the eye is inside the model; otherwise (an aerial orbit view,
   * the usual way into walk mode) the spot the view is aimed at, so entering
   * walk mode lands you where you were looking instead of on the roof.
   */
  spawn(eye: Vec3, look: Vec3): WalkSpawn {
    const b = this.world.bounds;
    if (!b) {
      // Nothing to stand on: an invisible floor at the spawn height, not a fall forever.
      this.character.groundY = eye.y - WALK_STAND_EYE;
      this.place(eye.x, this.character.groundY, eye.z);
      return 'free';
    }
    const inside = eye.x >= b.min.x && eye.x <= b.max.x && eye.z >= b.min.z && eye.z <= b.max.z
      && eye.y >= b.min.y && eye.y <= b.max.y + WALK_STAND_HEIGHT;
    if (inside) {
      const floor = this.floorBelow(eye.x, eye.y, eye.z);
      if (floor !== null) {
        this.placeFitting(eye.x, floor, eye.z);
        return 'floor-below';
      }
    }

    const len = Math.hypot(look.x, look.y, look.z);
    if (len > 1e-9) {
      const dx = look.x / len, dy = look.y / len, dz = look.z / len;
      const reach = Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * 2 + 100;
      const hit = this.world.raycast(eye.x, eye.y, eye.z, dx, dy, dz, reach);
      if (hit) {
        // Back off the surface toward the viewer so a wall hit lands in front
        // of the wall, then look for the floor there.
        const back = Math.min(hit.t, 0.6);
        const hx = eye.x + dx * (hit.t - back);
        const hz = eye.z + dz * (hit.t - back);
        // Probe from a little above the hit, so a hit on a floor finds that
        // floor; prefer the first floor under a ceiling, so aiming at a roof
        // enters the building there instead of standing on top of it.
        const floor = this.interiorFloorBelow(hx, eye.y + dy * hit.t + 0.5, hz);
        if (floor !== null) {
          this.placeFitting(hx, floor, hz);
          return 'view-target';
        }
      }
      // The view ray found nothing (aimed past the edge, into a courtyard).
      const spot = this.searchFootprint(eye, dx, dz, look, b);
      if (spot) {
        this.place(spot.x, spot.y, spot.z);
        return 'view-target';
      }
    }

    this.place(eye.x, this.character.groundY, eye.z);
    return 'ground-plane';
  }

  /**
   * Somewhere to stand when the view ray hit nothing. First along the line of
   * sight's ground track across the model's footprint (the nearest building
   * in view), then anywhere on a grid over the footprint, nearest the aim
   * point. Probes drop from above the model: past the target the line itself
   * runs underground. Enclosed spots win over open ones at every stage, since
   * a ledge outside a facade is under a ceiling too, and one step off it is a
   * long fall.
   */
  private searchFootprint(eye: Vec3, dx: number, dz: number, look: Vec3, b: { min: Vec3; max: Vec3 }): Vec3 | null {
    const footprint = { min: { x: b.min.x, y: -Infinity, z: b.min.z }, max: { x: b.max.x, y: Infinity, z: b.max.z } };
    // A view straight up or down has no ground track (and would sample at
    // t = Infinity): go straight to the grid.
    const span = Math.hypot(dx, dz) > 1e-9 ? rayBox(eye, dx, 0, dz, footprint) : null;
    let firstOpen: Vec3 | null = null;
    if (span) {
      for (let i = 0; i < LINE_OF_SIGHT_SAMPLES; i++) {
        const t = span[0] + ((span[1] - span[0]) * (i + 0.5)) / LINE_OF_SIGHT_SAMPLES;
        const x = eye.x + dx * t, z = eye.z + dz * t;
        const y = this.interiorFloorBelow(x, b.max.y + 0.5, z);
        if (y === null) continue;
        if (this.isEnclosed(x, y, z)) return { x, y, z };
        firstOpen ??= { x, y, z };
      }
    }

    // Grid cells nearest the aim point first, so the first enclosed one is
    // the answer and the search stops there.
    const tx = eye.x + look.x, tz = eye.z + look.z;
    const cells: Array<{ x: number; z: number; d: number }> = [];
    for (let i = 0; i < FOOTPRINT_GRID; i++) {
      for (let j = 0; j < FOOTPRINT_GRID; j++) {
        const x = b.min.x + ((b.max.x - b.min.x) * (i + 0.5)) / FOOTPRINT_GRID;
        const z = b.min.z + ((b.max.z - b.min.z) * (j + 0.5)) / FOOTPRINT_GRID;
        cells.push({ x, z, d: Math.hypot(x - tx, z - tz) });
      }
    }
    cells.sort((p, q) => p.d - q.d);
    let open: Vec3 | null = null;
    for (const { x, z } of cells) {
      const y = this.interiorFloorBelow(x, b.max.y + 0.5, z);
      if (y === null) continue;
      if (this.isEnclosed(x, y, z)) return { x, y, z };
      open ??= { x, y, z };
    }
    return firstOpen ?? open;
  }

  /** The capsule fits, and walls (or anything) bound the spot on all four sides at chest height. */
  private isEnclosed(x: number, floorY: number, z: number): boolean {
    if (this.character.overlaps(x, floorY, z, WALK_STAND_HEIGHT)) return false;
    for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!this.world.raycast(x, floorY + 1, z, ex, 0, ez, ENCLOSURE_REACH)) return false;
    }
    return true;
  }

  /**
   * The first floor-like surface straight below `y`, or null. Steeper hits (a
   * beam's side, a pitched roof) are passed through, up to a few of them.
   */
  private floorBelow(x: number, y: number, z: number): number | null {
    const b = this.world.bounds;
    if (!b) return null;
    let from = y;
    for (let attempts = 0; attempts < 8; attempts++) {
      const hit = this.world.raycast(x, from, z, 0, -1, 0, from - b.min.y + 1);
      if (!hit) return null;
      const floorY = from - hit.t;
      if (hit.ny > FLOOR_NORMAL) return floorY + 0.01;
      from = floorY - 0.01;
    }
    return null;
  }

  /**
   * Like {@link floorBelow}, but skips floors open to the sky (roofs,
   * terraces) for the first one with a ceiling at least a standing height
   * overhead. The clearance also rejects a slab's own underside, which a ray
   * that started inside the slab sees as a floor (winding is unreliable, so
   * the normal cannot tell). Falls back to the first floor when no covered
   * one fits (an open site).
   */
  private interiorFloorBelow(x: number, y: number, z: number): number | null {
    const first = this.floorBelow(x, y, z);
    let floor = first;
    for (let attempts = 0; floor !== null && attempts < 64; attempts++) {
      const ceiling = this.world.raycast(x, floor + 0.1, z, 0, 1, 0, 1e4);
      if (ceiling && ceiling.t + 0.1 >= WALK_STAND_HEIGHT) return floor;
      floor = this.floorBelow(x, floor - 0.05, z);
    }
    return first;
  }

  /**
   * Place at the spot, or, when a standing capsule does not fit there (a low
   * soffit, a column beside the hit), at the nearest spot on the same floor
   * within a metre or so that it does fit. Keeps the spot if none fits:
   * depenetration then pushes the walker out on the first step.
   */
  private placeFitting(x: number, y: number, z: number): void {
    const c = this.character;
    if (c.overlaps(x, y, z, WALK_STAND_HEIGHT)) {
      for (const r of FIT_RINGS) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          const nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r;
          const floor = this.floorBelow(nx, y + WALK_STAND_HEIGHT / 2, nz);
          if (floor === null || Math.abs(floor - y) > c.stepHeight) continue;
          if (!c.overlaps(nx, floor, nz, WALK_STAND_HEIGHT)) {
            this.place(nx, floor, nz);
            return;
          }
        }
      }
    }
    this.place(x, y, z);
  }

  /**
   * Stand at these feet without any search: a re-index keeping the walker
   * where it was (crouched under something stays crouched), or a float-mode
   * camera move.
   */
  resume(x: number, y: number, z: number, crouching = false): void {
    this.place(x, y, z);
    const c = this.character;
    c.crouching = crouching;
    c.height = crouching ? WALK_CROUCH_HEIGHT : WALK_STAND_HEIGHT;
    this.eyeHeight = crouching ? WALK_CROUCH_EYE : WALK_STAND_EYE;
  }

  private place(x: number, y: number, z: number): void {
    this.character.teleport(x, y, z);
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.visualY = y;
    this.accumulator = 0;
  }

  queueJump(): void {
    this.jumpQueued = true;
  }

  /**
   * Advance by a frame's elapsed seconds. `look` is the camera's view
   * direction; only its horizontal heading steers walking. Returns the eye.
   */
  frame(elapsed: number, input: WalkInput, look: Vec3): Vec3 {
    const c = this.character;
    this.accumulator = Math.min(this.accumulator + Math.max(0, elapsed), MAX_TICKS_PER_FRAME * WALK_TICK);
    const flat = Math.hypot(look.x, look.z);
    const fx = flat > 1e-9 ? look.x / flat : 0;
    const fz = flat > 1e-9 ? look.z / flat : 1;
    // Screen-right for a Y-up camera looking along (fx, fz) is (-fz, fx).
    const rx = -fz, rz = fx;
    let wx = fx * input.forward + rx * input.right;
    let wz = fz * input.forward + rz * input.right;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    while (this.accumulator >= WALK_TICK) {
      this.accumulator -= WALK_TICK;
      this.prevX = c.feetX; this.prevY = c.feetY; this.prevZ = c.feetZ;
      if (this.physics) {
        const speed = c.crouching ? CROUCH_SPEED : input.run ? RUN_SPEED : WALK_SPEED;
        c.step(WALK_TICK, { wishX: wx * speed, wishZ: wz * speed, jump: input.jump || this.jumpQueued, crouch: input.crouch });
      } else {
        const speed = FLOAT_SPEED * (input.run ? 2.5 : 1);
        const up = (input.jump ? 1 : 0) - (input.crouch ? 1 : 0);
        c.teleport(c.feetX + wx * speed * WALK_TICK, c.feetY + up * speed * WALK_TICK, c.feetZ + wz * speed * WALK_TICK);
      }
      this.jumpQueued = false;
    }

    const alpha = this.accumulator / WALK_TICK;
    const x = this.prevX + (c.feetX - this.prevX) * alpha;
    const y = this.prevY + (c.feetY - this.prevY) * alpha;
    const z = this.prevZ + (c.feetZ - this.prevZ) * alpha;
    const diff = y - this.visualY;
    if (this.physics && c.grounded && Math.abs(diff) < 0.45) {
      this.visualY += diff * (1 - Math.exp(-16 * elapsed));
    } else {
      this.visualY = y;
    }
    const targetEye = c.crouching && this.physics ? WALK_CROUCH_EYE : WALK_STAND_EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-12 * elapsed));
    return { x, y: this.visualY + this.eyeHeight, z };
  }

  /** True when nothing would change without input: grounded, still, eye settled. */
  isSettled(): boolean {
    const c = this.character;
    if (this.jumpQueued) return false;
    // The same target `frame` eases toward: float mode stands up from a crouch.
    const targetEye = c.crouching && this.physics ? WALK_CROUCH_EYE : WALK_STAND_EYE;
    if (Math.abs(this.eyeHeight - targetEye) >= 1e-3) return false;
    if (!this.physics) return true;
    return c.grounded && Math.abs(c.velX) < 1e-3 && Math.abs(c.velZ) < 1e-3 && c.velY === 0
      && Math.abs(c.feetY - this.visualY) < 1e-3;
  }
}
