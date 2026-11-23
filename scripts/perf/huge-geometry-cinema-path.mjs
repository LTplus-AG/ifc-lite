/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cinematic camera path of the huge-geometry showcase recorder
 * (huge-geometry-cinema.mjs). Pure: the shot list is a function of the
 * showcase manifest block only, in IFC world coordinates (Z up), so a before
 * clip and an after clip on any branch follow the identical path. Poses are a
 * function of shot time (not of rendered frames): a slow build shows fewer,
 * jumpier frames of the same motion, a fast one a smooth glide, and both clips
 * stay in lock-step for a side-by-side.
 *
 * The recorder maps IFC coordinates onto the viewer's world with `solveAxisMap`
 * (a signed axis permutation plus translation fitted to anchor elements whose
 * exact IFC centres the generator recorded), so nothing here depends on the
 * viewer's internal axis convention or origin shift.
 */

const DEG = Math.PI / 180;
const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];

/** Eye of an orbit pose: target + dist along (azimuth from +X, elevation above the XY plane), Z up. */
export function orbitEye({ target, az, el, dist }) {
  const ce = Math.cos(el * DEG);
  return [target[0] + dist * ce * Math.cos(az * DEG), target[1] + dist * ce * Math.sin(az * DEG), target[2] + dist * Math.sin(el * DEG)];
}

/** `{ eye, target }` of `shot` at shot fraction `u` in [0, 1]. */
export function poseAt(shot, u) {
  let v = Math.min(1, Math.max(0, u));
  if (shot.hold) {
    // A short still moment (the pick needs a camera at rest); the motion around it is time-compressed.
    const [h0, h1] = shot.hold, rest = 1 - (h1 - h0);
    v = v < h0 ? v / rest : v < h1 ? h0 / rest : (v - (h1 - h0)) / rest;
  }
  const k = shot.ease === 'linear' ? v : smooth(v);
  if (shot.kind === 'orbit') {
    const o = { target: lerp3(shot.from.target, shot.to.target, k), az: lerp(shot.from.az, shot.to.az, k), el: lerp(shot.from.el, shot.to.el, k),
      dist: shot.from.dist * Math.pow(shot.to.dist / shot.from.dist, k) };
    return { eye: orbitEye(o), target: o.target };
  }
  return { eye: lerp3(shot.from.eye, shot.to.eye, k), target: lerp3(shot.from.target, shot.to.target, k) };
}

/** Line shot from the end of `prev` to an explicit pose. */
const lineFrom = (prev, to, extra) => ({ kind: 'line', from: poseAt(prev, 1), to, ...extra });

/**
 * The shot list for a showcase manifest block (`manifest.showcase`).
 * Each shot: `{ name, caption, durationMs, kind: 'orbit'|'line', from, to, ease?, beat? }`.
 * Beats tell the recorder which feature to prove during that shot:
 * isolate (hero storey), section (horizontal cut sweep), colour (override on
 * the hero building), pick (click the pick target).
 */
export function buildShots(showcase) {
  const { bbox, hero } = showcase;
  const C = [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, 0];
  const hb = hero.bbox;
  const hh = Math.max(12, hb.max[2]);
  const hc = [(hb.min[0] + hb.max[0]) / 2, (hb.min[1] + hb.max[1]) / 2, hh * 0.45];
  const span = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1]);
  const R = Math.max(span / 2, hh * 1.2, 60);
  const heroSize = Math.max(hh, hb.max[0] - hb.min[0], hb.max[1] - hb.min[1]);
  const street = hero.street;
  const shots = [];
  const push = (s) => { shots.push(s); return s; };
  const cityT = [C[0], C[1], hh * 0.1];
  const flyIn = push({ name: 'fly-in', caption: 'fly-in from overview', durationMs: 7000, kind: 'orbit',
    from: { target: cityT, az: 150, el: 62, dist: R * 4.2 }, to: { target: cityT, az: 200, el: 34, dist: R * 1.55 } });
  const orbit = push({ name: 'orbit', caption: 'orbit', durationMs: 9000, kind: 'orbit',
    from: flyIn.to, to: { target: cityT, az: 288, el: 24, dist: R * 1.2 } });
  const streetStart = { eye: [street.from[0], street.from[1], 7], target: [street.from[0] - 14, street.from[1] + 50, 16] };
  push(lineFrom(orbit, streetStart, { name: 'dive', caption: 'dive to street level', durationMs: 6000 }));
  const streetEnd = { eye: [street.to[0], street.to[1], 4.5], target: [street.to[0] - 16, street.to[1] + 50, 20] };
  const streetShot = push({ name: 'street', caption: 'street level', durationMs: 6000, kind: 'line', ease: 'linear', from: streetStart, to: streetEnd });
  const storeyZ = (hero.storey ? hero.floors * 0.6 : hh * 0.5) * (showcase.floorHeight ?? 3.6);
  const plan = Math.max(hb.max[0] - hb.min[0], hb.max[1] - hb.min[1], 20);
  const isoFrom = { target: [hc[0], hc[1], storeyZ], az: 120, el: 34, dist: plan * 1.05 };
  push(lineFrom(streetShot, { eye: orbitEye(isoFrom), target: isoFrom.target }, { name: 'rise', caption: 'rise', durationMs: 3000 }));
  const iso = push({ name: 'isolate', caption: `isolate storey: ${hero.storey?.name ?? '–'} (${hero.storey?.ids.length ?? 0} elements)`, durationMs: 6000, kind: 'orbit',
    beat: 'isolate', from: isoFrom, to: { ...isoFrom, az: 175, el: 40, dist: plan * 0.8 } });
  const secFrom = { target: [hc[0], hc[1], 0], az: 175, el: 52, dist: Math.max(heroSize * 2.4, R * 0.55) };
  push(lineFrom(iso, { eye: orbitEye(secFrom), target: secFrom.target }, { name: 'to-section', caption: 'section cut', durationMs: 2500 }));
  const sec = push({ name: 'section', caption: 'section cut: horizontal plane sweeps down through the city', durationMs: 7000, kind: 'orbit',
    beat: 'section', from: secFrom, to: { ...secFrom, az: 225, el: 46, dist: secFrom.dist * 0.85 } });
  const colTo = { target: [hc[0], hc[1], hh * 0.4], az: 250, el: 24, dist: heroSize * 2.2 };
  const col = push({ name: 'colour', caption: `colour override: ${hero.name ?? 'hero'} (${hero.ids.length.toLocaleString('en-US')} elements)`, durationMs: 5500, kind: 'orbit',
    beat: 'colour', from: sec.to, to: colTo });
  const pk = hero.pick;
  const pickTarget = pk ? pk.centre : hc;
  const normal = pk ? pk.normal : [0, -1, 0];
  const pickEye = (d, up) => [pickTarget[0] + normal[0] * d + 6, pickTarget[1] + normal[1] * d, pickTarget[2] + up];
  push(lineFrom(col, { eye: pickEye(46, 10), target: pickTarget }, { name: 'to-pick', caption: 'pick an element', durationMs: 2500 }));
  const pick = push({ name: 'pick', caption: 'pick an element', durationMs: 5000, kind: 'line', beat: 'pick', hold: [0.25, 0.6],
    from: { eye: pickEye(46, 10), target: pickTarget }, to: { eye: pickEye(26, 4), target: pickTarget } });
  push(lineFrom(pick, { eye: orbitEye({ target: cityT, az: 330, el: 55, dist: R * 3 }), target: cityT }, { name: 'pull-back', caption: 'pull back', durationMs: 7000 }));
  return shots;
}

/** Total duration of a shot list in ms. */
export const totalMs = (shots) => shots.reduce((acc, s) => acc + s.durationMs, 0);

const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * Fit viewer = sign * permute(ifc) + offset to anchor pairs `{ ifc: [x,y,z], viewer: [x,y,z] }`
 * (at least 3, not collinear). Returns `{ perm, sign, offset, rms, apply(p) }`, or null.
 */
export function solveAxisMap(pairs) {
  if (pairs.length < 3) return null;
  let best = null;
  for (const perm of PERMS) {
    for (let m = 0; m < 8; m++) {
      const sign = [m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1];
      const map = (p) => [sign[0] * p[perm[0]], sign[1] * p[perm[1]], sign[2] * p[perm[2]]];
      const offset = [0, 1, 2].map((k) => pairs.reduce((acc, q) => acc + q.viewer[k] - map(q.ifc)[k], 0) / pairs.length);
      const err = pairs.reduce((acc, q) => { const v = map(q.ifc); return acc + [0, 1, 2].reduce((e, k) => e + (q.viewer[k] - v[k] - offset[k]) ** 2, 0); }, 0);
      const rms = Math.sqrt(err / pairs.length);
      if (!best || rms < best.rms) best = { perm, sign, offset, rms };
    }
  }
  const { perm, sign, offset } = best;
  return { ...best, apply: (p) => [0, 1, 2].map((k) => sign[k] * p[perm[k]] + offset[k]) };
}
