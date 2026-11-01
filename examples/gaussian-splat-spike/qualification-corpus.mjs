/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isCanonicalFixturePath, isGaussianFixturePath } from '../../scripts/fixtures/manifest-validation.mjs';
import { decodeQualification } from './qualification-decode.mjs';

// Offline byte/representation checks shared by licensed captures and analytic
// controls. This does not grant provenance or add controls to the public registry.
export async function decodeCorpusEntry(entry, bytes) {
  const format = entry.path?.split('.').at(-1).toLowerCase();
  if (!['ply', 'splat'].includes(format)) throw new Error(`Unsupported corpus format: ${format}`);
  assert.ok(isCanonicalFixturePath(entry.path) && isGaussianFixturePath(entry.path), 'expected admitted Gaussian fixture path');
  assert.equal(bytes.length, entry.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  const table = await decodeQualification(bytes, format);
  assert.equal(table.numRows, entry.gaussian.count);
  const column = name => {
    const data = table.getColumnByName(name)?.data;
    assert.ok(data && data.length === table.numRows, `missing or incomplete ${name}`);
    assert.ok(data.every(Number.isFinite), `${name} must be finite`);
    return data;
  };
  for (const name of ['x', 'y', 'z', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'scale_0', 'scale_1', 'scale_2']) column(name);
  for (let k = 0; k < 3 * ((entry.gaussian.sh_degree + 1) ** 2 - 1); k++) column(`f_rest_${k}`);
  const rotations = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(column);
  for (let row = 0; row < table.numRows; row++) {
    const norm = Math.hypot(...rotations.map(values => values[row]));
    // PLY preserves raw training parameters, including unnormalized rotations
    // and log scales. Packed .splat rotations retain their unit-length check.
    assert.ok(Number.isFinite(norm) && norm > 0, 'rotation must have a finite nonzero norm');
    if (format === 'splat') assert.ok(Math.abs(norm - 1) < 0.02);
  }
  return table;
}
