/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan-to-BIM test fixture (#6894): a seeded scan of one room held the way
 * the viewer's scan cache holds it, Y-up ((x, north, up) -> (x, up, -north)).
 * The room is 5 x 4 m (x 0..5, north 0..4), floor 0, ceiling 2.6, with a
 * round column r 0.25 at (3.5, 2); 3 mm noise. Detection proposes four
 * single-face walls, a floor and a ceiling slab and one column.
 */

type V3 = [number, number, number];

export const ROOM = { width: 5, depth: 4, height: 2.6, column: { x: 3.5, north: 2, radius: 0.25 } } as const;

export function scanRoomSample(density = 2000): Float32Array {
  let state = 6894;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noise = () => (random() + random() + random() - 1.5) * 0.004;
  const out: number[] = [];
  const push = ([x, north, up]: V3) => out.push(x + noise(), up + noise(), -(north + noise()));
  const { width: w, depth: d, height: h, column: c } = ROOM;
  const outsideColumn = (x: number, north: number) => Math.hypot(x - c.x, north - c.north) > c.radius;
  const patch = (origin: V3, u: V3, v: V3, keep: (p: V3) => boolean = () => true) => {
    const area = Math.hypot(...u) * Math.hypot(...v);
    for (let i = 0; i < Math.round(area * density); i++) {
      const [s, t] = [random(), random()];
      const p: V3 = [0, 1, 2].map((a) => origin[a] + s * u[a] + t * v[a]) as V3;
      if (keep(p)) push(p);
    }
  };
  patch([0, 0, 0], [w, 0, 0], [0, d, 0], (p) => outsideColumn(p[0], p[1]));
  patch([0, 0, h], [w, 0, 0], [0, d, 0], (p) => outsideColumn(p[0], p[1]));
  patch([0, 0, 0], [0, d, 0], [0, 0, h]);
  patch([w, 0, 0], [0, d, 0], [0, 0, h]);
  patch([0, 0, 0], [w, 0, 0], [0, 0, h]);
  patch([0, d, 0], [w, 0, 0], [0, 0, h]);
  for (let i = 0; i < Math.round(2 * Math.PI * c.radius * h * density); i++) {
    const [angle, up] = [random() * 2 * Math.PI, random() * h];
    push([c.x + c.radius * Math.cos(angle), c.north + c.radius * Math.sin(angle), up]);
  }
  return Float32Array.from(out);
}
