/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getSortedSplatIndicesByDepth } from '@luma.gl/splats';
import { qualificationPly, malformedQualificationPly } from '../qualification-fixtures.mjs';
import { decodeQualification } from '../qualification-decode.mjs';

const manifest = JSON.parse(await readFile(new URL('../../../tests/models/manifest.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const column = (table, name) => table.getColumnByName(name).data;

test('SH3 coefficients and 32 overlapping batches survive real upstream PLY decode (#8567)', async () => {
  const table = await decodeQualification(qualificationPly(), 'ply');
  assert.equal(table.numRows, 32 * 257);
  for (let k = 0; k < 45; k++) {
    const sh = column(table, `f_rest_${k}`);
    for (let row = 0; row < table.numRows; row++) assert.equal(sh[row], ((row % 7) - 3) * (k + 1) / 1024);
  }
  const z = column(table, 'z');
  const depths = Float32Array.from(z, value => -value);
  const sorted = getSortedSplatIndicesByDepth(depths);
  assert.equal(sorted.length, table.numRows); // #8580: empty/truncated output must fail.
  for (let i = 0; i < sorted.length; i++) {
    // Far-to-near must interleave ALL batches, not concatenate local sorts.
    const depthRank = table.numRows - i - 1;
    assert.equal(sorted[i], (depthRank % 32) * 257 + Math.floor(depthRank / 32));
  }
});

for (const fixture of malformedQualificationPly()) {
  test(`bounded malformed PLY observation: ${fixture.id} (#8567)`, { timeout: 15000 }, async t => {
    let table, error;
    try { table = await decodeQualification(fixture.bytes, 'ply'); }
    catch (caught) { error = caught; }
    const outcome = error ? 'rejected' : column(table, 'x').every(Number.isFinite) ? 'accepted-finite' : 'accepted-nonfinite';
    t.diagnostic(JSON.stringify({ fixture: fixture.id, outcome, productionQualified: false, pending: fixture.pending ?? 'Integrated loader outcome not tested' }));
    if (fixture.expected === 'reject') assert.ok(error, 'truncated record must not become a successful fixture');
    else assert.ok(error || outcome === 'accepted-nonfinite', 'NaN must not silently become a finite position');
  });
}

for (const entry of manifest.files.filter(item => item.gaussian)) {
  test(`licensed corpus decode: ${entry.path} (#8567)`, async t => {
    let bytes;
    try { bytes = await readFile(new URL(`../../../tests/models/${entry.path}`, import.meta.url)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      t.skip(`Run pnpm fixtures ${entry.path}; missing corpus is NOT release qualification.`);
      return;
    }
    assert.equal(bytes.length, entry.size);
    assert.equal(sha256(bytes), entry.sha256);
    const table = await decodeQualification(bytes, 'splat');
    assert.equal(table.numRows, entry.gaussian.count);
    for (const name of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
      assert.ok(column(table, name).every(Number.isFinite), `${name} must be finite`);
    }
    for (let row = 0; row < table.numRows; row++) {
      const norm = Math.hypot(...['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(name => column(table, name)[row]));
      assert.ok(Math.abs(norm - 1) < 0.02);
    }
    t.diagnostic(JSON.stringify({ path: entry.path, sha256: entry.sha256, rows: table.numRows, units: entry.gaussian.units, productionQualified: false }));
  });
}
