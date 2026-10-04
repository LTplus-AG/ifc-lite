/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The walk-mode capsule: gravity, jump, crouch, step-up and stair snap-down,
 * resolved by iterative depenetration against the model's triangles.
 *
 * A port of RvtGo's `CharacterController` (public domain) to the viewer's
 * Y-up frame. Positions are the capsule's FEET. Deterministic for a given
 * input sequence: a fixed `dt` per call and no hidden clock.
 */

import type { WalkCollisionWorld } from './walkCollisionWorld.js';
import { TriangleList } from './walkTriangles.js';
import { closestSegmentTriangle } from './walkGeometry.js';

export const WALK_RADIUS = 0.3;
export const WALK_STAND_HEIGHT = 1.75;
export const WALK_CROUCH_HEIGHT = 1.2;
export const WALK_STAND_EYE = 1.62;
export const WALK_CROUCH_EYE = 1.07;
const GRAVITY = 12;
const JUMP_SPEED = 4.6;
/** Longest sub-move before depenetration, so a fast fall cannot tunnel a slab. */
const SUBSTEP = 0.08;
/** Contacts whose normal's up component exceeds this are floor (about 45°). */
const WALKABLE = 0.7;
const ITERATIONS = 4;
const TERMINAL_VELOCITY = 40;
/** Typical stair risers are 150-200 mm; 250 mm also takes kerbs and thresholds, not tables. */
export const DEFAULT_STEP_HEIGHT = 0.25;

interface Contacts {
  ground: boolean;
  ceiling: boolean;
  wall: boolean;
  wallNx: number;
  wallNz: number;
  /** May low contacts lift the capsule (grounded horizontal moves only)? */
  allowStep: boolean;
  stepped: boolean;
}

const freshContacts = (): Contacts => ({
  ground: false, ceiling: false, wall: false, wallNx: 0, wallNz: 0, allowStep: false, stepped: false,
});

export interface WalkStepInput {
  /** Desired horizontal velocity (world X/Z, m/s). */
  wishX: number;
  wishZ: number;
  jump: boolean;
  crouch: boolean;
}

export class WalkCharacter {
  feetX = 0; feetY = 0; feetZ = 0;
  velX = 0; velY = 0; velZ = 0;
  grounded = false;
  crouching = false;
  height = WALK_STAND_HEIGHT;
  stepHeight = DEFAULT_STEP_HEIGHT;
  /** The infinite ground plane that catches a fall off the model. */
  groundY = -Infinity;
  /** True when the last step climbed a riser (the eye smooths it). */
  steppedThisTick = false;

  private readonly tris = new TriangleList();
  private readonly closest = new Float64Array(6);
  // Scratch feet for the pure move helpers.
  private mx = 0; private my = 0; private mz = 0;

  constructor(private readonly world: WalkCollisionWorld) {}

  teleport(x: number, y: number, z: number): void {
    this.feetX = x; this.feetY = y; this.feetZ = z;
    this.velX = 0; this.velY = 0; this.velZ = 0;
    this.grounded = false;
  }

  step(dt: number, input: WalkStepInput): void {
    this.steppedThisTick = false;
    this.world.beginTick();
    this.updateCrouch(input.crouch);

    // Snappy on the ground, light air control.
    const accel = Math.min(1, (this.grounded ? 14 : 2.5) * dt);
    this.velX += (input.wishX - this.velX) * accel;
    this.velZ += (input.wishZ - this.velZ) * accel;

    let jumped = false;
    if (this.grounded && input.jump && !this.crouching) {
      this.velY = JUMP_SPEED;
      this.grounded = false;
      jumped = true;
    }
    this.velY = Math.max(this.velY - GRAVITY * dt, -TERMINAL_VELOCITY);
    const wasGrounded = this.grounded;
    // Grounded, low edges are support: the capsule rides up risers and rests
    // on nosings instead of being pushed off them (see `pushOut`).
    const canStep = wasGrounded && !jumped && this.stepHeight > 0;

    // Horizontal move.
    const dx = this.velX * dt;
    const dz = this.velZ * dt;
    if (dx * dx + dz * dz > 1e-12) {
      const contacts = freshContacts();
      contacts.allowStep = canStep;
      const startY = this.feetY;
      this.move(this.feetX, this.feetY, this.feetZ, dx, 0, dz, contacts);
      this.feetX = this.mx; this.feetY = this.my; this.feetZ = this.mz;
      this.steppedThisTick = contacts.stepped && this.feetY - startY > 0.01;
      if (contacts.wall) this.clipVelocity(contacts.wallNx, contacts.wallNz);
    }

    // Vertical move.
    const vertical = freshContacts();
    vertical.allowStep = canStep;
    this.move(this.feetX, this.feetY, this.feetZ, 0, this.velY * dt, 0, vertical);
    this.feetX = this.mx; this.feetY = this.my; this.feetZ = this.mz;
    this.grounded = false;
    if (vertical.ground && this.velY <= 0) {
      this.grounded = true;
      this.velY = 0;
    }
    if (vertical.ceiling && this.velY > 0) this.velY = 0;

    // Snap down stairs and off small lips instead of falling.
    if (!this.grounded && wasGrounded && !jumped && this.velY <= 0) {
      const snap = freshContacts();
      snap.allowStep = true;
      this.move(this.feetX, this.feetY, this.feetZ, 0, -this.stepHeight - 0.02, 0, snap);
      if (snap.ground) {
        this.feetX = this.mx; this.feetY = this.my; this.feetZ = this.mz;
        this.grounded = true;
        this.velY = 0;
      }
    }

    if (this.feetY <= this.groundY) {
      this.feetY = this.groundY;
      if (this.velY <= 0) {
        this.grounded = true;
        this.velY = 0;
      }
    }
  }

  /** True if a capsule standing at the given feet intersects anything. */
  overlaps(fx: number, fy: number, fz: number, height: number): boolean {
    const r = WALK_RADIUS;
    const tris = this.tris;
    tris.clear();
    this.world.gather(fx - r, fy, fz - r, fx + r, fy + height, fz + r, tris);
    const limit = (r - 0.01) * (r - 0.01);
    const d = tris.data;
    for (let t = 0; t < tris.length; t++) {
      const o = t * 9;
      const dist = closestSegmentTriangle(fx, fy + r, fz, fx, fy + height - r, fz,
        d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7], d[o + 8], this.closest);
      if (dist < limit) return true;
    }
    return false;
  }

  private updateCrouch(crouch: boolean): void {
    if (crouch) {
      this.crouching = true;
      this.height = WALK_CROUCH_HEIGHT;
    } else if (this.crouching && !this.overlaps(this.feetX, this.feetY, this.feetZ, WALK_STAND_HEIGHT)) {
      this.crouching = false;
      this.height = WALK_STAND_HEIGHT;
    }
  }

  /** Remove the horizontal velocity component pushing into a wall. */
  private clipVelocity(nx: number, nz: number): void {
    const len = Math.hypot(nx, nz);
    if (len < 1e-5) return;
    nx /= len; nz /= len;
    const into = this.velX * nx + this.velZ * nz;
    if (into < 0) {
      this.velX -= nx * into;
      this.velZ -= nz * into;
    }
  }

  /**
   * Move from the given feet by the delta in sub-steps, resolving penetration
   * after each. The result lands in `mx/my/mz`. Triangles are gathered once
   * for the whole swept box rather than per sub-step.
   */
  private move(fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, contacts: Contacts): void {
    const r = WALK_RADIUS + 0.05;
    const h = this.height;
    const tris = this.tris;
    tris.clear();
    // The step-down and depenetration can lift the feet by up to a radius.
    this.world.gather(
      Math.min(fx, fx + dx) - r, Math.min(fy, fy + dy) - 0.05, Math.min(fz, fz + dz) - r,
      Math.max(fx, fx + dx) + r, Math.max(fy, fy + dy) + h + WALK_RADIUS, Math.max(fz, fz + dz) + r,
      tris,
    );
    const length = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(length / SUBSTEP));
    const sx = dx / steps, sy = dy / steps, sz = dz / steps;
    this.mx = fx; this.my = fy; this.mz = fz;
    for (let i = 0; i < steps; i++) {
      this.mx += sx; this.my += sy; this.mz += sz;
      this.resolve(contacts);
    }
  }

  private resolve(contacts: Contacts): void {
    const tris = this.tris;
    const d = tris.data;
    const r = WALK_RADIUS;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      let pushed = false;
      for (let t = 0; t < tris.length; t++) {
        const o = t * 9;
        // Cheap box reject against the capsule's current box.
        const x0 = this.mx - r - 0.02, x1 = this.mx + r + 0.02;
        const z0 = this.mz - r - 0.02, z1 = this.mz + r + 0.02;
        const y0 = this.my - 0.02, y1 = this.my + this.height + 0.02;
        if (Math.max(d[o], d[o + 3], d[o + 6]) < x0 || Math.min(d[o], d[o + 3], d[o + 6]) > x1) continue;
        if (Math.max(d[o + 2], d[o + 5], d[o + 8]) < z0 || Math.min(d[o + 2], d[o + 5], d[o + 8]) > z1) continue;
        if (Math.max(d[o + 1], d[o + 4], d[o + 7]) < y0 || Math.min(d[o + 1], d[o + 4], d[o + 7]) > y1) continue;
        if (this.pushOut(o, contacts)) pushed = true;
      }
      if (this.my < this.groundY) {
        this.my = this.groundY;
        contacts.ground = true;
      }
      if (!pushed) break;
    }
  }

  /** Resolve one triangle contact; true if the capsule moved. */
  private pushOut(o: number, contacts: Contacts): boolean {
    const d = this.tris.data;
    const r = WALK_RADIUS;
    const px = this.mx, py = this.my + r, pz = this.mz;
    const qy = this.my + this.height - r;
    const c = this.closest;
    const distSq = closestSegmentTriangle(px, py, pz, px, qy, pz,
      d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7], d[o + 8], c);
    if (distSq >= r * r) return false;

    // Face normal: decides riser/tread versus slope, and orients a piercing contact.
    const e1x = d[o + 3] - d[o], e1y = d[o + 4] - d[o + 1], e1z = d[o + 5] - d[o + 2];
    const e2x = d[o + 6] - d[o], e2y = d[o + 7] - d[o + 1], e2z = d[o + 8] - d[o + 2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const flen = Math.hypot(fx, fy, fz);
    if (flen < 1e-12) return false;
    fx /= flen; fy /= flen; fz /= flen;

    const dist = Math.sqrt(distSq);
    let nx: number, ny: number, nz: number;
    if (dist > 1e-5) {
      nx = (c[0] - c[3]) / dist; ny = (c[1] - c[4]) / dist; nz = (c[2] - c[5]) / dist;
    } else {
      nx = fx; ny = fy; nz = fz;
      const cy = (py + qy) / 2;
      if ((px - c[3]) * nx + (cy - c[4]) * ny + (pz - c[5]) * nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    }

    // Step: a low contact on a riser (near-vertical face) or a tread's edge
    // (walkable face) lifts the capsule straight up until it clears, so the
    // round bottom rides over a nosing instead of being pushed back by it.
    // Steep slopes are excluded: they stay walls.
    const contactHeight = c[4] - this.my;
    const faceUp = Math.abs(fy);
    if (contacts.allowStep && ny <= WALKABLE && contactHeight > 0 && contactHeight <= this.stepHeight
        && (faceUp > WALKABLE || faceUp < 0.3)) {
      const hx = c[0] - c[3], hz = c[2] - c[5];
      const h2 = hx * hx + hz * hz;
      if (h2 < r * r) {
        const lift = Math.sqrt(r * r - h2) - (c[1] - c[4]) + 0.0005;
        if (lift > 0) {
          this.my += lift;
          contacts.ground = true;
          contacts.stepped = true;
          return true;
        }
      }
    }

    const depth = r - dist + 0.0005;
    if (ny > WALKABLE) {
      // Floors push straight up: no sliding down ramps or stair nosings.
      this.my += depth / ny;
      contacts.ground = true;
    } else if (ny < -WALKABLE) {
      this.mx += nx * depth; this.my += ny * depth; this.mz += nz * depth;
      contacts.ceiling = true;
    } else {
      this.mx += nx * depth; this.my += ny * depth; this.mz += nz * depth;
      contacts.wall = true;
      contacts.wallNx += nx;
      contacts.wallNz += nz;
    }
    return true;
  }
}
