/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * City layout of the huge-geometry SHOWCASE look (huge-geometry-showcase.mjs):
 * the square spiral of blocks and the typology/wing plan of each block.
 * Pure functions of (seed, block index).
 */

import { prng } from './gen-dense-ifc.mjs';
import { mix } from './huge-geometry-shapes.mjs';

export const BLOCK = Object.freeze({ lot: 72, street: 16, pitch: 88 });
export const BAY = 3.0;

/** Square spiral: block index -> grid cell (0,0), (1,0), (1,1), (0,1), (-1,1), ... every cell exactly once. */
export function spiral(n) {
  if (n === 0) return [0, 0];
  const k = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
  const side = 2 * k, start = (2 * k - 1) ** 2; // first index of ring k
  const o = n - start; // 0 .. 8k-1
  if (o < side) return [k, -k + 1 + o];
  if (o < 2 * side) return [k - 1 - (o - side), k];
  if (o < 3 * side) return [-k, k - 1 - (o - 2 * side)];
  return [-k + 1 + (o - 3 * side), -k];
}

/** Wings (rectangular floor plates with a storey range) of the building(s) on block `b`; `[]` is a park. */
export function blockPlan(seed, b) {
  const [gx, gy] = spiral(b);
  const ring = Math.max(Math.abs(gx), Math.abs(gy));
  const r = prng(mix(seed, 0xB10C, b));
  const fall = Math.exp(-ring / 4);
  const between = (lo, hi) => lo + (hi - lo) * r();
  const even = (v) => Math.max(BAY, Math.round(v / BAY) * BAY);
  if (b > 0 && r() < 0.1) return { gx, gy, ring, kind: 'park', buildings: [] };
  const pick = b === 0 ? 0 : r();
  const landmark = ring > 1 && r() < 0.05;
  const buildings = [];
  if (pick < 0.3 || landmark) {
    const floors = Math.max(8, Math.round((14 + 36 * (landmark ? 0.9 : fall)) * between(0.65, 1)));
    const tw = even(between(18, 27)), td = even(between(18, 27)), pf = Math.round(between(3, 5));
    const pw = even(between(42, 60)), pd = even(between(36, 54));
    buildings.push({ kind: 'tower', wings: [{ x: -pw / 2, y: -pd / 2, w: pw, d: pd, f0: 0, f1: pf, core: false },
      { x: -tw / 2 + even(between(-6, 6)), y: -td / 2 + even(between(-6, 6)), w: tw, d: td, f0: 0, f1: floors, core: true }] });
  } else if (pick < 0.55) {
    const n = 2 + Math.floor(r() * 2), depth = even(between(12, 16)), gap = (64 - n * depth) / Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const len = even(between(42, 64)), floors = Math.max(3, Math.round((4 + 12 * fall) * between(0.6, 1.2)));
      buildings.push({ kind: 'bar', wings: [{ x: -len / 2, y: -32 + i * (depth + gap), w: len, d: depth, f0: 0, f1: floors, core: true }] });
    }
  } else if (pick < 0.8) {
    const depth = even(between(12, 15)), floors = Math.max(3, Math.round((5 + 8 * fall) * between(0.7, 1.15))), s = 60;
    buildings.push({ kind: 'court', wings: [
      { x: -s / 2, y: -s / 2, w: s, d: depth, f0: 0, f1: floors, core: true },
      { x: -s / 2, y: s / 2 - depth, w: s, d: depth, f0: 0, f1: floors, core: false },
      { x: -s / 2, y: -s / 2 + depth, w: depth, d: s - 2 * depth, f0: 0, f1: floors + 2, core: true },
      { x: s / 2 - depth, y: -s / 2 + depth, w: depth, d: s - 2 * depth, f0: 0, f1: floors, core: false }] });
  } else {
    const n = 3 + Math.floor(r() * 2);
    const spots = [[-17, -17], [17, -17], [-17, 17], [17, 17]];
    for (let i = 0; i < n; i++) {
      const s = even(between(15, 21)), floors = Math.max(4, Math.round((6 + 22 * fall) * between(0.5, 1.2)));
      buildings.push({ kind: 'point', wings: [{ x: spots[i][0] - s / 2, y: spots[i][1] - s / 2, w: s, d: s, f0: 0, f1: floors, core: true }] });
    }
  }
  return { gx, gy, ring, kind: buildings[0].kind, buildings };
}
