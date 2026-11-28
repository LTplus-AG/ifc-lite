/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Camera } from './camera.js';
import type { Vec3 } from './raycaster.js';

type CameraProjection = Pick<Camera, 'projectToScreen'> & Partial<Pick<Camera, 'getRelativeToEyeFrame'>>;
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Clip to the same depth range as Camera.projectToScreen before dividing by w. */
export function edgeProjector(camera: CameraProjection, width: number, height: number) {
  const frame = camera.getRelativeToEyeFrame?.();
  if (!frame) {
    return (a: Vec3, b: Vec3) => {
      const sa = camera.projectToScreen(a, width, height), sb = camera.projectToScreen(b, width, height);
      return sa && sb ? { a, b, sa, sb, wa: 1, wb: 1 } : null;
    };
  }
  if (!frame.isAvailable()) return () => null;
  const snapshot = frame.snapshot();
  const m = snapshot.getViewProjection().m;
  const clip = (p: Vec3) => {
    const [x, y, z] = snapshot.worldToRelative([p.x, p.y, p.z]);
    const row = (r: number) => m[r] * x + m[r + 4] * y + m[r + 8] * z + m[r + 12];
    return { x: row(0), y: row(1), z: row(2), w: row(3) };
  };
  return (a: Vec3, b: Vec3) => {
    const ca = clip(a), cb = clip(b);
    let lo = 0, hi = 1;
    for (const sign of [-1, 1]) {
      const da = ca.w + sign * ca.z, db = cb.w + sign * cb.z;
      if (!Number.isFinite(da) || !Number.isFinite(db) || (da < 0 && db < 0)) return null;
      if (da < 0) lo = Math.max(lo, da / (da - db));
      if (db < 0) hi = Math.min(hi, da / (da - db));
    }
    if (hi < lo) return null;
    const w = (t: number) => ca.w + (cb.w - ca.w) * t;
    const wa = w(lo), wb = w(hi);
    if (!(wa > 0 && wb > 0)) return null;
    const screen = (t: number, weight: number) => ({
      x: (1 + (ca.x + (cb.x - ca.x) * t) / weight) * width / 2,
      y: (1 - (ca.y + (cb.y - ca.y) * t) / weight) * height / 2,
    });
    return { a: lo === 0 ? a : lerp(a, b, lo), b: hi === 1 ? b : lerp(a, b, hi),
      sa: screen(lo, wa), sb: screen(hi, wb), wa, wb };
  };
}
