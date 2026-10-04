/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { segmentScanPlanes, type ScanSegmentationEngine } from './scan-segmentation.js';

// Real wasm, never a mock: a mocked engine would only echo its own report.
// Skips when the runtime is not built (`bash scripts/build-wasm.sh`).
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const built = existsSync(WASM);

/** Seeded Y-up corner: floor y = 0 (3 x 3 m) and wall z = 0 (3 m long, 2.5 m high). */
function corner(points: number): Float32Array {
  let state = 6870;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const out = new Float32Array(points * 3);
  for (let i = 0; i < points; i++) {
    const [a, b] = [random() * 3, random() * 3];
    const noise = (random() - 0.5) * 0.004;
    out.set(i % 2 === 0 ? [a, noise, b] : [a, (b / 3) * 2.5, noise], i * 3);
  }
  return out;
}

describe.skipIf(!built)('segmentScanPlanes over the real wasm boundary (#6870)', () => {
  let api: (ScanSegmentationEngine & { free(): void }) | undefined;
  beforeAll(async () => {
    const wasm = await import('@ifc-lite/wasm');
    wasm.initSync({ module: readFileSync(WASM) });
    api = new wasm.IfcAPI();
  });
  afterAll(() => api?.free());

  it('reads only the filled prefix of a reservoir buffer and classifies a Y-up frame', () => {
    if (!api) throw new Error('wasm engine not initialised');
    const filled = corner(40_000);
    // A reservoir allocates ahead of its fill: trailing slots are junk.
    const buffer = new Float32Array(filled.length + 3 * 5_000).fill(Number.NaN);
    buffer.set(filled);
    const report = segmentScanPlanes(api, { positions: buffer, count: 40_000 }, { upAxis: [0, 1, 0] });
    expect(report.stats.inputPoints).toBe(40_000);
    expect(report.stats.rejectedPoints).toBe(0);
    const floor = report.planes.find((p) => p.orientation === 'horizontal');
    const wall = report.planes.find((p) => p.orientation === 'vertical');
    expect(report.planes).toHaveLength(2);
    expect(Math.abs(floor?.normal[1] ?? 0)).toBeGreaterThan(0.999);
    expect(Math.abs(wall?.normal[2] ?? 0)).toBeGreaterThan(0.999);
    expect(floor?.normalSource).toBe('canonical');
    expect(floor?.normal[1]).toBeGreaterThan(0); // canonical horizontal planes face up
  });

  it('refuses a count beyond the buffer before calling wasm, and surfaces Rust option errors', () => {
    if (!api) throw new Error('wasm engine not initialised');
    const positions = corner(10);
    expect(() => segmentScanPlanes(api!, { positions, count: 11 })).toThrow(RangeError);
    expect(() => segmentScanPlanes(api!, { positions }, { voxelSizeMetres: 5 })).toThrow(/voxelSizeMetres/);
  });
});
