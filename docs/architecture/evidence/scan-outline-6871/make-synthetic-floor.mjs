/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Usage: node make-synthetic-floor.mjs out.ply  (1.5 M points, seeded)
// Synthetic floor scan (Z-up, metres): rooms, partitions with doors, windows,
// a column, furniture, floor and ceiling. Binary little-endian PLY with RGB.
import { writeFileSync } from 'node:fs';
let a = 42; const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-300))) * Math.cos(2 * Math.PI * rand());
const H = 2.8, ROT = 12 * Math.PI / 180, OX = 5, OY = 3;
const pts = [];
const push = (x, y, z, c) => { const xr = Math.cos(ROT) * x - Math.sin(ROT) * y + OX, yr = Math.sin(ROT) * x + Math.cos(ROT) * y + OY; pts.push([xr + 0.003 * gauss(), yr + 0.003 * gauss(), z + 0.003 * gauss(), c]); };
// A wall box [x0,y0,x1,y1] from z0 to z1, sampled on its 4 vertical faces, with openings [axis-pos, from, to, zlo, zhi] skipped.
const boxes = [];
const wall = (x0, y0, x1, y1, holes = []) => boxes.push({ b: [x0, y0, x1, y1], holes });
const T = 0.3, t = 0.12, W = 14, D = 10;
wall(-T, -T, W + T, 0, [[3, 4.2, 0.9, 2.1], [8, 9.2, 0.9, 2.1]]);           // south, two windows
wall(-T, D, W + T, D + T, [[2, 3.2, 0.9, 2.1], [10, 11.2, 0.9, 2.1]]);      // north
wall(-T, 0, 0, D, [[4, 5.2, 0.9, 2.1]]);                                    // west
wall(W, 0, W + T, D, [[1.5, 2.5, 0, 2.1]]);                                 // east, entrance door
wall(6, 0, 6 + t, 6.0, [[2.0, 2.9, 0, 2.1]]);                               // partition with door
wall(6, 6.0, W, 6.0 + t, [[3.5, 4.4, 0, 2.1]]);                             // corridor wall with door
wall(10, 6.0 + t, 10 + t, D, []);
wall(0, 4.0, 3.5, 4.0 + t, []);                                              // small room
wall(3.5, 4.0, 3.5 + t, D, [[1.2, 2.1, 0, 2.1]]);
const inside = (x, y) => boxes.some(({ b }) => x > b[0] + 1e-6 && x < b[2] - 1e-6 && y > b[1] + 1e-6 && y < b[3] - 1e-6);
const solid = (x, y) => boxes.some(({ b }) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
const DENS = 9000; // points per m² of face
for (const { b, holes } of boxes) {
  const [x0, y0, x1, y1] = b; const horiz = (x1 - x0) >= (y1 - y0);
  const faces = [[x0, y0, x1, y0, 0, -1], [x1, y0, x1, y1, 1, 0], [x1, y1, x0, y1, 0, 1], [x0, y1, x0, y0, -1, 0]];
  for (const [ax, ay, bx, by, nx, ny] of faces) {
    const len = Math.hypot(bx - ax, by - ay); const n = Math.round(len * H * DENS * 0.25);
    for (let i = 0; i < n; i++) {
      const s = rand(), z = rand() * H; const x = ax + s * (bx - ax), y = ay + s * (by - ay);
      if (solid(x + nx * 1e-4, y + ny * 1e-4)) continue;
      const along = horiz ? x - x0 : y - y0;
      if (holes.some(([f, to, zl, zh]) => along > f && along < to && z > zl && z < zh)) continue;
      push(x, y, z, [205, 200, 190]);
    }
    // jambs/reveals of openings: sample the opening's side faces
  }
  for (const [f, to, zl, zh] of holes) for (const at of [f, to]) for (let i = 0; i < 400; i++) {
    const z = zl + rand() * (zh - zl); const depth = horiz ? y0 + rand() * (y1 - y0) : x0 + rand() * (x1 - x0);
    if (horiz) push(x0 + at, depth, z, [180, 175, 165]); else push(depth, y0 + at, z, [180, 175, 165]);
  }
}
// column
for (let i = 0; i < 12000; i++) { const s = rand() * 1.6, z = rand() * H; const [x, y] = s < 0.4 ? [9 + s, 3] : s < 0.8 ? [9.4, 3 + s - 0.4] : s < 1.2 ? [9.4 - (s - 0.8), 3.4] : [9, 3.4 - (s - 1.2)]; push(x, y, z, [150, 150, 160]); }
// floor and ceiling
for (let i = 0; i < 500000; i++) { const x = rand() * W, y = rand() * D; if (solid(x, y)) continue; push(x, y, rand() < 0.5 ? 0 : H, [120, 110, 100]); }
// furniture: tables (top at 0.75) and a cabinet (to 1.8 m, cut by the slab)
for (const [cx, cy, w, d, h] of [[2, 2, 1.6, 0.8, 0.75], [11, 8, 1.2, 0.8, 0.75], [12.4, 2.5, 0.6, 1.6, 1.8], [1.0, 8.5, 0.5, 1.2, 1.8]]) {
  for (let i = 0; i < 30000; i++) { const s = rand(); const z = rand() * h; const per = 2 * (w + d); let u = s * per; let x, y; if (u < w) [x, y] = [cx + u, cy]; else if ((u -= w) < d) [x, y] = [cx + w, cy + u]; else if ((u -= d) < w) [x, y] = [cx + w - u, cy + d]; else [x, y] = [cx, cy + d - (u - w)]; push(x, y, rand() < 0.3 ? h : z, [140, 90, 60]); }
}
// clutter / noise
for (let i = 0; i < 4000; i++) push(rand() * W, rand() * D, rand() * H, [90, 90, 90]);
const n = pts.length;
const header = `ply\nformat binary_little_endian 1.0\ncomment synthetic floor scan for #6871\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
const buf = Buffer.alloc(header.length + n * 15); buf.write(header, 0, 'ascii'); let o = header.length;
for (const [x, y, z, c] of pts) { buf.writeFloatLE(x, o); buf.writeFloatLE(y, o + 4); buf.writeFloatLE(z, o + 8); buf[o + 12] = c[0]; buf[o + 13] = c[1]; buf[o + 14] = c[2]; o += 15; }
writeFileSync(process.argv[2], buf); console.log('points', n);
