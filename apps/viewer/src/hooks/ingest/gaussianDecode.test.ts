// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGaussianFile } from './gaussianDecode.js';

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
