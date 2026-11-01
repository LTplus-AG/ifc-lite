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
import { decodeCorpusEntry } from '../qualification-corpus.mjs';

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
    const table = await decodeCorpusEntry(entry, bytes);
    t.diagnostic(JSON.stringify({ path: entry.path, sha256: entry.sha256, rows: table.numRows, units: entry.gaussian.units, productionQualified: false }));
  });
}

for (const extension of ['ply', 'PLY']) test(`analytic SH3 ${extension} uses the corpus entry path (#8580)`, async () => {
  const bytes = qualificationPly({ batches: 2, perBatch: 3 });
  // Raw PLY rotations need not be normalized. Do not apply packed .splat rules.
  const headerEnd = bytes.indexOf('end_header\n') + 'end_header\n'.length;
  const stride = (bytes.length - headerEnd) / 6;
  bytes.writeFloatLE(2, headerEnd + stride - 16);
  const entry = { path: `gaussian/analytic-sh3.${extension}`, size: bytes.length,
    sha256: sha256(bytes), gaussian: { count: 6, sh_degree: 3 } };
  const table = await decodeCorpusEntry(entry, bytes);
  assert.equal(table.numRows, 6);
  assert.equal(column(table, 'rot_0')[0], 2, 'upstream PLY preserves raw rotation');
  assert.equal(column(table, 'scale_0')[0], -2, 'upstream PLY preserves log scale');
  for (let k = 0; k < 45; k++) for (let row = 0; row < 6; row++) {
    assert.equal(column(table, `f_rest_${k}`)[row], ((row % 7) - 3) * (k + 1) / 1024);
  }
  await assert.rejects(decodeCorpusEntry({ ...entry, size: bytes.length + 1 }, bytes));
  await assert.rejects(decodeCorpusEntry({ ...entry, sha256: '0'.repeat(64) }, bytes));
  await assert.rejects(decodeCorpusEntry({ ...entry, gaussian: { ...entry.gaussian, count: 7 } }, bytes));
});

test('corpus dispatch refuses unsupported formats rather than defaulting to splat (#8580)', async () => {
  await assert.rejects(decodeCorpusEntry({ path: 'gaussian/control.spz' }, new Uint8Array()), /Unsupported corpus format/);
});
