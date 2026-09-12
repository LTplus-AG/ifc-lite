/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { streamPointCloud } from './host.js';
import { PLY_STREAM_READ_BYTES } from './ply-stream-decode.js';
import { PlyStreamingSource } from './ply-source.js';

class TrackingBlob extends Blob {
  readonly requestedSliceBytes: number[] = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const from = start ?? 0;
    const to = end ?? this.size;
    this.requestedSliceBytes.push(Math.max(0, to - from));
    return super.slice(start, end, contentType);
  }
}

describe('PlyStreamingSource source normals (#4561)', () => {
  it('keeps XYZ, RGB and normals on the same rows through stride downsampling', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `${i} ${i + 10} ${i + 20} ${i * 10} ${i * 10 + 1} ${i * 10 + 2} ${i + 0.1} ${i + 0.2} ${i + 0.3}`);
    const text = 'ply\nformat ascii 1.0\nelement vertex 5\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n'
      + rows.join('\n') + '\n';
    const source = new PlyStreamingSource(new Blob([text]), { downsample: { stride: 2 } });
    await source.open();
    const chunk = await source.next(100);
    expect(chunk?.pointCount).toBe(3);
    expect(Array.from(chunk!.positions)).toEqual([0, 10, 20, 2, 12, 22, 4, 14, 24]);
    expect(Array.from(chunk!.colors!).map(v => Math.round(v * 255))).toEqual([0, 1, 2, 20, 21, 22, 40, 41, 42]);
    expect(Array.from(chunk!.normals!)).toEqual([0.1, 0.2, 0.3, 2.1, 2.2, 2.3, 4.1, 4.2, 4.3].map(Math.fround));
  });

  it('honours maxPoints across ASCII chunks without losing stride phase', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `${i} 0 0 ${i} 0 1`);
    const text = 'ply\nformat ascii 1.0\nelement vertex 8\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n'
      + rows.join('\n') + '\n';
    const source = new PlyStreamingSource(new Blob([text]), { downsample: { stride: 3 } });
    await source.open();
    const chunks = [await source.next(1), await source.next(1), await source.next(1), await source.next(1)];
    expect(chunks.map(chunk => chunk?.positions[0] ?? null)).toEqual([0, 3, 6, null]);
    expect(chunks.slice(0, 3).every(chunk => chunk?.pointCount === 1 && chunk.normals?.length === 3)).toBe(true);
  });

  it('latches an invalid normal from an unretained stride row across every emitted chunk', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `${i} 0 0 ${i === 1 ? 0 : 1} 0 0`);
    const text = 'ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n' + rows.join('\n') + '\n';
    const source = new PlyStreamingSource(new Blob([text]), { downsample: { stride: 2 } });
    await source.open();
    expect((await source.next(2))?.normalState).toBe('invalid');
    expect((await source.next(2))?.normalState).toBe('invalid');
  });

  it.each(['1e-100', '1e100'])('invalidates an unretained normal that cannot survive Float32 storage (%s)', async (nx) => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
      + 'property double nx\nproperty double ny\nproperty double nz\nend_header\n'
      + `0 0 0 1 0 0\n1 0 0 ${nx} 0 0\n2 0 0 1 0 0\n`;
    const source = new PlyStreamingSource(new Blob([text]), { downsample: { stride: 2 } });
    await source.open();
    expect((await source.next(10))?.normalState).toBe('invalid');
  });

  it.each([1e-100, 1e100])('applies Float32 normal validity to unretained binary-double rows (%s)', async (nx) => {
    const header = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 3\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property double nx\nproperty double ny\nproperty double nz\nend_header\n');
    const body = new ArrayBuffer(3 * 36), view = new DataView(body);
    for (let row = 0; row < 3; row++) {
      const base = row * 36;
      view.setFloat32(base, row, true);
      view.setFloat64(base + 12, row === 1 ? nx : 1, true);
      view.setFloat64(base + 20, 0, true);
      view.setFloat64(base + 28, 0, true);
    }
    const source = new PlyStreamingSource(new Blob([header, body]), { downsample: { stride: 2 } });
    await source.open();
    expect((await source.next(10))?.normalState).toBe('invalid');
  });

  it('selects the floating RGB convention once for the whole file, independent of chunk size', async () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n'
      + 'property float red\nproperty float green\nproperty float blue\nend_header\n0 0 0 .5 0 0\n1 0 0 255 0 0\n';
    const source = new PlyStreamingSource(new Blob([text]));
    await source.open();
    expect((await source.next(1))!.colors![0]).toBeCloseTo(0.5 / 255);
    expect((await source.next(1))!.colors![0]).toBe(1);
  });

  it.each(['Infinity', '1.0000000001'])('matches whole-buffer Float32 color convention for %s', async (red) => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n'
      + 'property double red\nproperty double green\nproperty double blue\nend_header\n'
      + `0 0 0 .5 0 0\n1 0 0 ${red} 0 0\n`;
    const source = new PlyStreamingSource(new Blob([text]));
    await source.open();
    expect((await source.next(1))!.colors![0]).toBe(0.5);
  });

  it('traverses variable ASCII normal lists without losing XYZ and marks the source invalid', async () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty list uchar float nx\nproperty float y\nproperty float z\nend_header\n'
      + '1 2 9 10 2 3\n4 1 8 5 6\n';
    const source = new PlyStreamingSource(new Blob([text]));
    await source.open();
    const chunk = await source.next(2);
    expect(Array.from(chunk!.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunk!.normalState).toBe('invalid');
    expect(chunk!.normals).toBeUndefined();
  });

  it('traverses variable binary normal lists across rows without fixed-stride drift', async () => {
    const header = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty list uchar float nx\nproperty float y\nproperty float z\nend_header\n');
    const body = new ArrayBuffer(4 + 1 + 8 + 8 + 4 + 1 + 4 + 8), view = new DataView(body);
    let at = 0;
    const scalar = (value: number) => { view.setFloat32(at, value, true); at += 4; };
    scalar(1); view.setUint8(at++, 2); scalar(9); scalar(10); scalar(2); scalar(3);
    scalar(4); view.setUint8(at++, 1); scalar(8); scalar(5); scalar(6);
    const source = new PlyStreamingSource(new Blob([header, body]));
    await source.open();
    const chunk = await source.next(2);
    expect(Array.from(chunk!.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunk!.normalState).toBe('invalid');
  });

  it('keeps safe-integer strides above the 32-bit range instead of wrapping to one (#4561 review)', async () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 3\n'
      + 'property float x\nproperty float y\nproperty float z\nend_header\n'
      + '1 0 0\n2 0 0\n3 0 0\n';
    const source = new PlyStreamingSource(new Blob([text]), { downsample: { stride: 2 ** 32 } });
    const info = await source.open();
    expect(info.totalPointCount).toBe(1);
    expect(Array.from((await source.next(2))!.positions)).toEqual([1, 0, 0]);
    expect(await source.next(2)).toBeNull();
  });

  it('reports the bounded streaming-header limit explicitly (#4561 review)', async () => {
    const text = 'ply\nformat ascii 1.0\ncomment ' + 'x'.repeat(70_000)
      + '\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n';
    const source = new PlyStreamingSource(new Blob([text]));
    await expect(source.open()).rejects.toThrow('PLY: header exceeds the bounded 65536-byte streaming limit');
  });

  it('decodes binary normal rows directly into bounded stride chunks', async () => {
    const header = new TextEncoder().encode('ply\nformat binary_big_endian 1.0\nelement vertex 5\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n');
    const body = new ArrayBuffer(5 * 24), view = new DataView(body);
    for (let row = 0; row < 5; row++) for (let field = 0; field < 6; field++) view.setFloat32(row * 24 + field * 4, row * 10 + field, false);
    const source = new PlyStreamingSource(new Blob([header, body]), { downsample: { stride: 2 } });
    const info = await source.open();
    expect(info.totalPointCount).toBe(3);
    const first = await source.next(2), second = await source.next(2);
    expect(Array.from(first!.positions)).toEqual([0, 1, 2, 20, 21, 22]);
    expect(Array.from(first!.normals!)).toEqual([3, 4, 5, 23, 24, 25]);
    expect(Array.from(second!.positions)).toEqual([40, 41, 42]);
    expect(Array.from(second!.normals!)).toEqual([43, 44, 45]);
    expect(await source.next(2)).toBeNull();
  });

  it('bounds sparse binary reads and preserves global stride phase across next calls (#4561 review)', async () => {
    const paddingProperties = Array.from({ length: 250 }, (_, i) => `property float pad${i}\n`).join('');
    const header = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 5001\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property float nx\nproperty float ny\nproperty float nz\n'
      + paddingProperties + 'end_header\n');
    const recordSize = 1024;
    const body = new ArrayBuffer(5001 * recordSize), view = new DataView(body);
    for (const [row, x] of [[0, 11], [5000, 22]] as const) {
      const base = row * recordSize;
      view.setFloat32(base, x, true);
      view.setFloat32(base + 12, row + 1, true);
      view.setFloat32(base + 16, row + 2, true);
      view.setFloat32(base + 20, row + 3, true);
    }
    const blob = new TrackingBlob([header, body]);
    const source = new PlyStreamingSource(blob, { downsample: { stride: 5000 } });
    await source.open();
    const first = await source.next(1), second = await source.next(1);
    expect([first?.positions[0], second?.positions[0]]).toEqual([11, 22]);
    expect(Array.from(first!.normals!)).toEqual([1, 2, 3]);
    expect(Array.from(second!.normals!)).toEqual([5001, 5002, 5003]);
    expect(await source.next(1)).toBeNull();
    expect(Math.max(...blob.requestedSliceBytes)).toBeLessThanOrEqual(Math.max(PLY_STREAM_READ_BYTES, recordSize));
  });

  it('applies a tiny host cap before allocating decoded point channels (#4561 review)', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => `${i + 1000} ${i} ${i + 20} ${i} 0 0 1 0 0`);
    const text = 'ply\nformat ascii 1.0\nelement vertex 9\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n'
      + rows.join('\n') + '\n';
    const allocations: number[] = [], emitted: number[] = [];
    const handle = streamPointCloud({
      format: 'ply', blob: new Blob([text]), maxPointsInMemory: 2, chunkSize: 1, autoOrigin: true,
      createSource: options => new PlyStreamingSource(options.blob, {
        downsample: { stride: options.stride ?? 1 }, originOffset: options.originOffset,
        instrumentation: { onOutputAllocation: capacity => allocations.push(capacity) },
      }),
      onChunk: chunk => {
        emitted.push(chunk.pointCount);
        expect(chunk.positions.length).toBe(chunk.pointCount * 3);
        expect(chunk.colors?.length).toBe(chunk.pointCount * 3);
        expect(chunk.normals?.length).toBe(chunk.pointCount * 3);
      },
    });
    await handle.done;
    expect(emitted).toEqual([1, 1]);
    expect(allocations).toEqual([1, 1]);
    expect(Math.max(...allocations)).toBeLessThan(9);
  });
});
