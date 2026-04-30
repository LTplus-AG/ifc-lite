/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { LasStreamingSource } from './las-source.js';

function buildLasFile(rows: Array<{ x: number; y: number; z: number }>): Blob {
  const headerSize = 227;
  const pointDataOffset = headerSize;
  const recordLen = 20; // format 0
  const total = headerSize + rows.length * recordLen;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);

  view.setUint32(0, 0x4653414c, true);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, pointDataOffset, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 0);
  view.setUint16(105, recordLen, true);
  view.setUint32(107, rows.length, true);
  view.setFloat64(131, 1, true);
  view.setFloat64(139, 1, true);
  view.setFloat64(147, 1, true);
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const r of rows) {
    if (r.x < minX) minX = r.x; if (r.x > maxX) maxX = r.x;
    if (r.y < minY) minY = r.y; if (r.y > maxY) maxY = r.y;
    if (r.z < minZ) minZ = r.z; if (r.z > maxZ) maxZ = r.z;
  }
  view.setFloat64(179, maxX, true);
  view.setFloat64(187, minX, true);
  view.setFloat64(195, maxY, true);
  view.setFloat64(203, minY, true);
  view.setFloat64(211, maxZ, true);
  view.setFloat64(219, minZ, true);

  for (let i = 0; i < rows.length; i++) {
    const off = headerSize + i * recordLen;
    view.setInt32(off, rows[i].x, true);
    view.setInt32(off + 4, rows[i].y, true);
    view.setInt32(off + 8, rows[i].z, true);
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

describe('LasStreamingSource', () => {
  it('reports total point count and bbox after open', async () => {
    const blob = buildLasFile([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 20, z: 30 },
      { x: -5, y: -10, z: -15 },
    ]);
    const src = new LasStreamingSource(blob);
    const info = await src.open();
    expect(info.totalPointCount).toBe(3);
    expect(info.bbox).toEqual({ min: [-5, -10, -15], max: [10, 20, 30] });
    expect(info.hasColor).toBe(false);
    expect(info.hasClassification).toBe(true);
  });

  it('emits chunks of the requested size and stops on completion', async () => {
    const rows: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 7; i++) rows.push({ x: i, y: 0, z: 0 });
    const src = new LasStreamingSource(buildLasFile(rows));
    await src.open();

    const a = await src.next(3);
    const b = await src.next(3);
    const c = await src.next(3);
    const done = await src.next(3);

    expect(a?.pointCount).toBe(3);
    expect(b?.pointCount).toBe(3);
    expect(c?.pointCount).toBe(1);
    expect(done).toBeNull();

    // Concatenated x values should round-trip 0..6
    const xs: number[] = [];
    for (const ch of [a, b, c]) {
      for (let i = 0; i < ch!.pointCount; i++) xs.push(ch!.positions[i * 3]);
    }
    expect(xs).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('honours a stride > 1 to downsample', async () => {
    const rows: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 10; i++) rows.push({ x: i, y: 0, z: 0 });
    const src = new LasStreamingSource(buildLasFile(rows), { downsample: { stride: 2 } });
    const info = await src.open();
    expect(info.totalPointCount).toBe(5);
    const all = await src.next(100);
    expect(all?.pointCount).toBe(5);
    const xs = Array.from({ length: all!.pointCount }, (_, i) => all!.positions[i * 3]);
    expect(xs).toEqual([0, 2, 4, 6, 8]);
  });

  it('aborts cleanly between chunks', async () => {
    const blob = buildLasFile([{ x: 1, y: 2, z: 3 }]);
    const src = new LasStreamingSource(blob);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(src.open(ctrl.signal)).rejects.toThrow();
  });
});
