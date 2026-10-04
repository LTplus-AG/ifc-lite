/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan outline test fixture (#6871): the real wasm runtime, initialised once
 * (skipping the test when it is not built), and a seeded slab of points on
 * the faces of a 6 m × 4 m room with 0.2 m walls, offset to (20, 30) in
 * drawing space.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { initSync } from '@ifc-lite/wasm';

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');
let wasmReady = false;
export function ensureWasm(t: TestContext): boolean {
  if (!existsSync(WASM_PATH)) {
    t.skip('wasm bundle not built: run `pnpm build:wasm:fetch`');
    return false;
  }
  if (!wasmReady) {
    initSync({ module: readFileSync(WASM_PATH) });
    wasmReady = true;
  }
  return true;
}

/** Seeded slab on the faces of a 6 m × 4 m room with 0.2 m walls, offset to (20, 30). */
export function roomSlab(): Float32Array {
  let a = 6871;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-300))) * Math.cos(2 * Math.PI * rand());
  const faces = [
    [0, 0, 6, 0], [6, 0, 6, 4], [6, 4, 0, 4], [0, 4, 0, 0],
    [-0.2, -0.2, 6.2, -0.2], [6.2, -0.2, 6.2, 4.2], [6.2, 4.2, -0.2, 4.2], [-0.2, 4.2, -0.2, -0.2],
  ];
  const out: number[] = [];
  for (const [x0, y0, x1, y1] of faces) {
    const n = Math.round(Math.hypot(x1 - x0, y1 - y0) * 300);
    for (let i = 0; i < n; i++) {
      const t = rand();
      out.push(20 + x0 + t * (x1 - x0) + 0.003 * gauss(), 30 + y0 + t * (y1 - y0) + 0.003 * gauss());
    }
  }
  return Float32Array.from(out);
}
