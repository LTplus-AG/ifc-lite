// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, tsv } from './metrics.mjs';
test('#7955 parity refuses missing products, changed codes and excessive volume error', () => {
  const native = tsv('model\tid\tstatus\tcode\tvolume_m3\nm\t27\tpublished\t\t6\nm\t80\trefused\tincomplete\t');
  const actual = [{ model: 'm', id: 27, status: 'published', volumeM3: 6 }, { model: 'm', id: 80, status: 'refused', code: 'incomplete' }];
  assert.deepEqual(compare(native, actual, native, 1e-9).violations, []);
  assert.ok(compare(native, actual.slice(1), native, 1e-9).violations.length);
  assert.ok(compare(native, [{ ...actual[0], volumeM3: 6.0000001 }, actual[1]], native, 1e-9).violations.length);
  assert.ok(compare(native, [actual[0], { ...actual[1], code: 'source_invalid' }], native, 1e-9).violations.length);
  assert.ok(compare(native, [actual[0], { ...actual[1], code: 'contract_breach' }], native, 1e-9).violations.length);
});

test('#7955 a published final TSV row preserves its empty refusal code', () => {
  const rows = tsv('model\tid\tstatus\tcode\nm\t27\tpublished\t\n');
  assert.equal(rows[0].code, '');
  assert.deepEqual(compare([{ ...rows[0], volume_m3: '6' }], [{ ...rows[0], volumeM3: 6 }], rows, 1e-9).violations, []);
});

// #7955 CUT-0: the parity gate consumes every slice and rejects split ownership.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coverageRows } from './coverage.mjs';
test('#7955 coverage fragments preserve codes and unique model ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cut0-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'coverage');
  const header = 'model\tid\tstatus\tcode\n';
  await writeFile(`${base}.tsv`, `${header}base.ifc\t1\tpublished\t\n`);
  assert.equal((await coverageRows(base)).length, 1);
  await mkdir(`${base}.d`);
  await writeFile(`${base}.d/cut-0.tsv`, `${header}clips.ifc\t2\trefused\toperation_unsupported\nclips.ifc\t3\trefused\topening_strategy\n`);
  assert.deepEqual((await coverageRows(base)).map(row => row.code), ['', 'operation_unsupported', 'opening_strategy']);
  await writeFile(`${base}.d/other.tsv`, `${header}clips.ifc\t4\trefused\tsource_invalid\n`);
  await assert.rejects(coverageRows(base), /spans coverage files/);
  await rm(`${base}.d/other.tsv`);
  await writeFile(`${base}.d/cut-0.tsv`, `${header}clips.ifc\t2\trefused\toperation_unsupported\nclips.ifc\t2\tpublished\t\n`);
  await assert.rejects(coverageRows(base), /Duplicate coverage row/);
});
