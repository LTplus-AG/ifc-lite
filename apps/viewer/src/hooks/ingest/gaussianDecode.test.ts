// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createChunkDataPool, MemoryReadFileSystem, readPly, materializeToDataTable } from '@playcanvas/splat-transform';
import { inspectGaussianAdmission } from './gaussianAdmission.js';
// A production-only revert removes this new module. Load inside each test so
// that missing decode capability fails an assertion, rather than file loading.
async function decodeGaussianFile(file: File) {
  const decoder = await import('./gaussianDecode.js').catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(decoder, 'Gaussian captures must have a worker decoder before their channel contracts can be verified');
  return decoder.decodeGaussianFile(file);
}

const base = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
function ply(degree = 0, overrides: Record<string, number> = {}) {
  const names = [...base, ...Array.from({ length: [0, 9, 24, 45][degree] }, (_, i) => `f_rest_${i}`)];
  const body = new ArrayBuffer(names.length * 4);
  const data = new DataView(body);
  names.forEach((name, i) => data.setFloat32(i * 4, overrides[name] ?? (name === 'rot_0' ? 1 : i / 100), true));
  return new File([`ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names.map(name => `property float ${name}\n`).join('')}end_header\n`, body], 'source.ply');
}

for (const degree of [0, 1, 2, 3]) it(`real upstream decoder preserves raw SH${degree} and source coordinates (#8565)`, async () => {
  const decoded = await decodeGaussianFile(ply(degree, { x: 123, y: -45, z: 67, scale_0: Math.log(2), opacity: -2 }));
  assert.equal(decoded.count, 1);
  assert.equal(decoded.shDegree, degree);
  assert.deepEqual(decoded.centerBounds, { min: [123, -45, 67], max: [123, -45, 67] });
  assert.equal(decoded.columns.scale_0[0], Math.fround(Math.log(2)));
  assert.equal(decoded.columns.opacity[0], -2);
  assert.equal(Object.keys(decoded.columns).length, 14 + [0, 9, 24, 45][degree]);
  if (degree === 3) assert.equal(decoded.columns.f_rest_44[0], Math.fround(58 / 100));
});

for (const name of ['x', 'y', 'z', 'rot_0', 'scale_1', 'opacity', 'f_dc_2', 'f_rest_44']) {
  for (const value of [NaN, Infinity, -Infinity]) it(`rejects upstream-preserved ${name}=${value} before publication (#8565)`, async () => {
    await assert.rejects(decodeGaussianFile(ply(3, { [name]: value })), /Non-finite/);
  });
}

it('rejects finite logs whose covariance cannot survive float32 and degenerate rotation (#8565)', async () => {
  for (const scale of [100, -100]) await assert.rejects(decodeGaussianFile(ply(0, { scale_0: scale })), /covariance/);
  await assert.rejects(decodeGaussianFile(ply(0, { rot_0: 0, rot_1: 0, rot_2: 0, rot_3: 0 })), /rotation/);
});

it('decodes real 32-byte splat framing via upstream without implicit placement (#8565)', async () => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  [1, -2, 3, 2, 3, 4].forEach((value, i) => view.setFloat32(i * 4, value, true));
  bytes.set([128, 64, 255, 128, 255, 128, 128, 128], 24);
  const decoded = await decodeGaussianFile(new File([bytes], 'capture.splat'));
  assert.deepEqual(decoded.centerBounds.min, [1, -2, 3]);
  assert.equal(decoded.shDegree, 0);
  assert.ok(Math.abs(Math.exp(decoded.columns.scale_0[0]) - 2) < 1e-6);
  bytes[0] = 0; view.setFloat32(0, NaN, true);
  await assert.rejects(decodeGaussianFile(new File([bytes], 'bad.splat')), /Non-finite/);
});

it('ordinary PLY and truncated Gaussian payload never enter decoding (#8565)', async () => {
  await assert.rejects(decodeGaussianFile(new File(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n'], 'ordinary.ply')), /Not a Gaussian/);
  await assert.rejects(decodeGaussianFile(new File([new Uint8Array(31)], 'broken.splat')), /Truncated/);
});

// These are actual binary PLY records, including extras the output does not retain.
function layoutPly(count: number, extras = 0, metadata: 'before' | 'after' | 'none' = 'none') {
  const stride = base.length * 4 + extras * 8;
  const body = new ArrayBuffer(count * stride);
  const view = new DataView(body);
  for (let row = 0; row < count; row++) {
    base.forEach((name, i) => view.setFloat32(row * stride + i * 4,
      name === 'x' ? 1 : name === 'y' ? 2 : name === 'z' ? 3 : name === 'rot_0' ? 1 : 0, true));
  }
  const metaHeader = 'element metadata 1\nproperty float value\n';
  const metaBody = new ArrayBuffer(4);
  new DataView(metaBody).setFloat32(0, 123, true);
  const header = `ply\nformat binary_little_endian 1.0\n${metadata === 'before' ? metaHeader : ''}element vertex ${count}\n`
    + base.map(name => `property float ${name}\n`).join('')
    + Array.from({ length: extras }, (_, i) => `property double e${i}\n`).join('')
    + (metadata === 'after' ? metaHeader : '') + 'end_header\n';
  return new File([header, ...(metadata === 'before' ? [metaBody] : []), body,
    ...(metadata === 'after' ? [metaBody] : [])], 'layout.ply');
}

// Intercept numeric Uint8Array construction BEFORE allocation, so the negative
// control can prove the 603.5 MiB request without ever allocating that memory.
async function boundedScratch<T>(run: () => Promise<T>) {
  const original = globalThis.Uint8Array;
  const requested: number[] = [];
  globalThis.Uint8Array = new Proxy(original, {
    construct(target, args: unknown[]) {
      if (typeof args[0] === 'number') {
        requested.push(args[0]);
        if (args[0] > 16 * 1024 * 1024) throw new Error(`Scratch allocation refused: ${args[0]}`);
      }
      return Reflect.construct(target, args);
    },
  });
  try { return { result: await run(), requested }; }
  finally { globalThis.Uint8Array = original; }
}

for (const count of [1, 1800]) it(`bounds full-stride scratch and actual rows with ${count} wide records (#8565)`, async () => {
  const file = layoutPly(count, 1200);
  const { result, requested } = await boundedScratch(() => decodeGaussianFile(file));
  assert.equal(result.count, count);
  assert.deepEqual(result.centerBounds, { min: [1, 2, 3], max: [1, 2, 3] });
  assert.equal(Object.keys(result.columns).length, 14);
  const stride = 14 * 4 + 1200 * 8;
  const expected = Math.min(count, Math.floor(16 * 1024 * 1024 / stride)) * stride;
  assert.ok(requested.includes(expected), 'real upstream record scratch was observed');
  if (count === 1) assert.ok(Math.max(...requested) < 1024 * 1024, 'one row cannot reserve a full chunk');
});

it('negative control safely catches the upstream fixed-chunk scratch request (#8565)', async () => {
  const file = layoutPly(1, 1200);
  await assert.rejects(boundedScratch(() => rawUpstream(file, 65_536)), /Scratch allocation refused: 632815616/);
});

it('rejects preceding-element offsets while preserving vertex-first trailing elements (#8565)', async () => {
  const before = layoutPly(1, 0, 'before');
  // Negative control: the unguarded pinned upstream reader consumes metadata as x.
  const wrong = await rawUpstream(before, 1);
  assert.deepEqual(['x', 'y', 'z'].map(name => wrong.getColumnByName(name)?.data[0]), [123, 1, 2]);
  await assert.rejects(decodeGaussianFile(before), /element before vertex/);
  const after = await decodeGaussianFile(layoutPly(1, 0, 'after'));
  assert.deepEqual(after.centerBounds.min, [1, 2, 3]);
  const ordinary = new File(['ply\nformat ascii 1.0\nelement metadata 1\nproperty float value\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n123\n1 2 3\n'], 'ordinary.ply');
  assert.deepEqual(await inspectGaussianAdmission(ordinary, await ordinary.arrayBuffer()), { kind: 'ordinary' });
});

async function rawUpstream(file: File, chunkSize: number) {
  const fs = new MemoryReadFileSystem();
  fs.set('capture', new Uint8Array(await file.arrayBuffer()));
  const input = await fs.createSource('capture');
  const pool = createChunkDataPool({ chunkSize, maxPooledBytes: 16 * 1024 * 1024 });
  const source = await readPly(input, pool);
  try { return await materializeToDataTable(source, pool, new Set(['position', 'geometric', 'color'])); }
  finally { try { await source.close(); } finally { pool.destroy(); } }
}
