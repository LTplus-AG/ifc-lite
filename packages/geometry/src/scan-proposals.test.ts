/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { segmentScan, type ScanSegmentationEngine } from './scan-segmentation.js';
import { proposeScanElements, type ScanProposalEngine } from './scan-proposals.js';

// Real wasm, never a mock. Skips when the runtime is not built
// (`bash scripts/build-wasm.sh`). The proposal logic itself is tested in
// Rust (`rust/processing/tests/scan_proposals.rs`); this pins the boundary.
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const built = existsSync(WASM);

/**
 * Seeded Y-up scan (viewer frame: x east, y up, z = -north): a 4 m long,
 * 2.5 m high partition 0.2 m thick (faces north = 0 and north = 0.2) with a
 * floor on either side.
 */
function partition(points: number): Float32Array {
  let state = 6894;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const out = new Float32Array(points * 3);
  for (let i = 0; i < points; i++) {
    const [a, b] = [random(), random()];
    const noise = (random() - 0.5) * 0.004;
    const x = a * 4;
    let p: [number, number, number];
    switch (i % 4) {
      case 0: p = [x, b * 2.5, -(0 + noise)]; break; // south face
      case 1: p = [x, b * 2.5, -(0.2 + noise)]; break; // north face
      case 2: p = [x, noise, -(-3 + b * 3)]; break; // floor south
      default: p = [x, noise, -(0.2 + b * 3)]; break; // floor north
    }
    out.set(p, i * 3);
  }
  return out;
}

/** Y-up (x, y, z) to IFC Z-up (x, -z, y), then a georeferenced offset. */
const Y_UP_TO_MODEL = [1, 0, 0, 2_600_000, 0, 0, -1, 1_200_000, 0, 1, 0, 410, 0, 0, 0, 1];

describe.skipIf(!built)('proposeScanElements over the real wasm boundary (#6894)', () => {
  let api: (ScanSegmentationEngine & ScanProposalEngine & { free(): void }) | undefined;
  beforeAll(async () => {
    const wasm = await import('@ifc-lite/wasm');
    wasm.initSync({ module: readFileSync(WASM) });
    api = new wasm.IfcAPI();
  });
  afterAll(() => api?.free());

  it('pairs the partition faces into one wall in the georeferenced model frame', () => {
    if (!api) throw new Error('wasm engine not initialised');
    const report = segmentScan(api, { positions: partition(120_000) }, { upAxis: [0, 1, 0] });
    const proposals = proposeScanElements(api, report, { scanToModel: Y_UP_TO_MODEL });
    const walls = proposals.proposals.filter((p) => p.ifcClass === 'IfcWall');
    expect(walls).toHaveLength(1);
    const [wall] = walls;
    expect(wall.basis).toBe('pairedFaces');
    expect(wall.sources.map((s) => s.kind)).toEqual(['plane', 'plane']);
    if (wall.geometry.kind !== 'wall') throw new Error('not a wall');
    const { start, end, thicknessMetres, heightMetres } = wall.geometry;
    expect(thicknessMetres).toBeCloseTo(0.2, 1);
    expect(heightMetres).toBeGreaterThan(2.3);
    // Axis at north 0.1 (model y), from the georeferenced offset; base at the floor.
    expect(start[1] - 1_200_000).toBeCloseTo(0.1, 1);
    expect(end[1] - 1_200_000).toBeCloseTo(0.1, 1);
    expect(Math.abs(end[0] - start[0])).toBeGreaterThan(3.8);
    expect(start[2] - 410).toBeCloseTo(0, 1);
    expect(proposals.transformScale).toBe(1);
  });

  it('refuses a malformed transform before wasm and surfaces Rust option errors', () => {
    if (!api) throw new Error('wasm engine not initialised');
    const report = segmentScan(api, { positions: partition(1_000) }, {});
    expect(() => proposeScanElements(api!, report, { scanToModel: [1, 0, 0] })).toThrow(/16 row-major/);
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => proposeScanElements(api!, report, { scanToModel: mirror })).toThrow(/reflect/);
  });
});
