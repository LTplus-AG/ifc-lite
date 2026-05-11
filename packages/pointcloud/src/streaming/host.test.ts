/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { streamPointCloud } from './host.js';
import { LasStreamingSource } from './las-source.js';
import type { StreamingPointSource } from './types.js';

function buildLasFile(rows: Array<{ x: number; y: number; z: number }>): Blob {
  const headerSize = 227;
  const recordLen = 20;
  const total = headerSize + rows.length * recordLen;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x4653414c, true);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
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

describe('streamPointCloud (in-process source)', () => {
  it('streams chunks to the host callback and reports completion', async () => {
    const rows: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 12; i++) rows.push({ x: i, y: 0, z: 0 });

    const collected: number[] = [];
    let opened = 0;
    let completedTotal = 0;

    const handle = streamPointCloud({
      format: 'las',
      blob: buildLasFile(rows),
      chunkSize: 5,
      onOpen: (info) => {
        opened++;
        expect(info.totalPointCount).toBe(12);
        expect(info.stride).toBe(1);
      },
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.pointCount; i++) {
          collected.push(chunk.positions[i * 3]);
        }
      },
      onComplete: (_bbox, total) => {
        completedTotal = total;
      },
      // Run the source in-process — the worker glue isn't available
      // in node:test/vitest's environment.
      createSource: ({ blob, label, stride }) => new LasStreamingSource(blob, {
        label,
        downsample: { stride },
      }),
    });

    await handle.done;
    expect(opened).toBe(1);
    expect(completedTotal).toBe(12);
    expect(collected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('downsamples when total exceeds maxPointsInMemory', async () => {
    const rows: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 100; i++) rows.push({ x: i, y: 0, z: 0 });

    let openInfo: { totalPointCount: number; stride: number } | null = null;
    const collected: number[] = [];

    const handle = streamPointCloud({
      format: 'las',
      blob: buildLasFile(rows),
      maxPointsInMemory: 10,
      chunkSize: 50,
      onOpen: (info) => { openInfo = info; },
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.pointCount; i++) {
          collected.push(chunk.positions[i * 3]);
        }
      },
      createSource: ({ blob, stride }) => new LasStreamingSource(blob, {
        downsample: { stride },
      }),
    });

    await handle.done;
    expect(openInfo).not.toBeNull();
    // ceil(100 / 10) = stride 10; expect ~10 emitted points (every 10th source row).
    const open = openInfo as unknown as { totalPointCount: number; stride: number };
    expect(open.stride).toBe(10);
    expect(open.totalPointCount).toBe(10);
    expect(collected).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('rejects files larger than maxFileSize', async () => {
    const blob = buildLasFile([{ x: 0, y: 0, z: 0 }]);
    let errored: Error | null = null;
    const handle = streamPointCloud({
      format: 'las',
      blob,
      maxFileSize: 10,
      onChunk: () => {},
      onError: (err) => { errored = err; },
      createSource: ({ blob: b, stride }) => new LasStreamingSource(b, {
        downsample: { stride },
      }),
    });
    await handle.done.catch(() => {});
    expect(errored).not.toBeNull();
    const e = errored as unknown as Error;
    expect(e.message).toContain('exceeds maxFileSize');
  });

  it('cancel() stops the stream cleanly', async () => {
    const rows: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 1000; i++) rows.push({ x: i, y: 0, z: 0 });
    let chunksSeen = 0;

    const handle = streamPointCloud({
      format: 'las',
      blob: buildLasFile(rows),
      chunkSize: 100,
      onChunk: () => {
        chunksSeen++;
        if (chunksSeen === 2) handle.cancel();
      },
      createSource: ({ blob, stride }) => new LasStreamingSource(blob, {
        downsample: { stride },
      }),
    });

    await handle.done.catch(() => {});
    // We should have seen at most a couple chunks before the cancel kicked in.
    expect(chunksSeen).toBeLessThan(10);
  });

  it('uses the createSource override (in-process source contract)', async () => {
    let factoryCalls = 0;
    const stub: StreamingPointSource = {
      open: async () => ({
        totalPointCount: 0,
        bbox: { min: [0, 0, 0], max: [0, 0, 0] },
        hasColor: false,
        hasClassification: false,
        hasIntensity: false,
      }),
      next: async () => null,
      close: () => {},
    };
    const handle = streamPointCloud({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      onChunk: () => {},
      createSource: () => {
        factoryCalls++;
        return stub;
      },
    });
    await handle.done;
    expect(factoryCalls).toBe(1);
  });
});
