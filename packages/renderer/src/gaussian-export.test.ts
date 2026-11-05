/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSplatSphericalHarmonics } from '@luma.gl/splats';
import { positionedGaussianChunks } from './gaussian/gaussian-export.js';
import { normalizeGaussianAttributes } from './gaussian/gaussian-attributes.js';

function source(count: number, degree: 0 | 1 | 2 | 3) {
  const columns: Record<string, Float32Array> = {};
  const names = ['x','y','z','rot_0','rot_1','rot_2','rot_3','scale_0','scale_1','scale_2','opacity','f_dc_0','f_dc_1','f_dc_2',
    ...Array.from({ length: ((degree + 1) ** 2 - 1) * 3 }, (_, i) => `f_rest_${i}`)];
  names.forEach((name, i) => { columns[name] = new Float32Array(count).fill(name === 'rot_0' ? 1 : name.startsWith('rot_') ? 0 : i / 100); });
  return { count, shDegree: degree, columns };
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []; for await (const value of values) result.push(value); return result;
}
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const near = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-5, `${a} != ${b}`);

for (const degree of [0,1,2,3] as const) test(`positioned Gaussian SH${degree} preserves directional radiance under a 90-degree Z rotation`, async () => {
  const input = source(1, degree);
  input.columns.opacity[0] = 100; // finite logit must not saturate through a normalized round-trip.
  const original = normalizeGaussianAttributes(input);
  const chunks = await collect(positionedGaussianChunks(input, [0,2,0,0,-2,0,0,0,0,0,2,0,5000000.125,0,0,1]));
  assert.equal(chunks.length,1);
  const out = chunks[0];
  near(out.x[0], 5000000.125 - 2 * input.columns.y[0]);
  near(out.y[0], 2 * input.columns.x[0]);
  near(out.scale_0[0], input.columns.scale_0[0] + Math.log(2));
  near(out.rot_0[0], Math.SQRT1_2); near(out.rot_3[0], Math.SQRT1_2);
  assert.equal(out.opacity[0],100);
  const output = normalizeGaussianAttributes({ count: 1, shDegree: degree,
    columns: Object.fromEntries(Object.entries(out).map(([name, array]) => [name, Float32Array.from(array)])) });
  for (const dir of [[1,0,0],[0,1,0],[0,0,1],[0.6,0,0.8]]) {
    const before = evaluateSplatSphericalHarmonics([0,0,0], original.sphericalHarmonics, dir, degree);
    const after = evaluateSplatSphericalHarmonics([0,0,0], output.sphericalHarmonics, [-dir[1],dir[0],dir[2]], degree);
    before.forEach((v,i) => near(v,after[i]));
  }
  assert.equal(input.columns.rot_3[0],0, 'export cannot mutate the loaded source');
});

test('Gaussian export chunks preserve every row, reject shear, and keep millimetre movement at large offsets', async () => {
  const input = source(8193,0); input.columns.x[8192] = 0.001;
  const matrix = [...identity]; matrix[12] = 5000000.125;
  const chunks = await collect(positionedGaussianChunks(input,matrix));
  assert.deepEqual(chunks.map(c=>c.x.length),[8192,1]);
  near(chunks[1].x[0],5000000.126);
  matrix[4] = 0.5;
  await assert.rejects(collect(positionedGaussianChunks(input,matrix)), /shear|non-uniform/);
});
