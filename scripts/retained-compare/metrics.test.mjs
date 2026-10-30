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

// #7955 M5 round 6: the exception is source-curved AND clipped, never the
// conservative runtime curved flag (which is true for planar Booleans too).
import { loadTolerances } from './tolerances.mjs';
test('#7955 M5 planar injected 1e-8 gap still fails the scoped parity gate', () => {
  const t = loadTolerances();
  assert.equal(t.nativeWasmVolumeRelative, 1e-9);
  const scoped = t.nativeWasmClippedCurvedVolumeRelative.value;
  const check = (sourceCurved, clipped, gap, pass = true) => {
    const native = [{ model: 'source.ifc', id: 7, status: 'published', code: '',
      volume_m3: '1', curved: 'true', src_oracle: JSON.stringify(clipped ? [{
        family: 'clipSectionVolumeRelative', sourceCurved, gated: true, pass,
        value: 0, limit: sourceCurved ? 2e-3 : 1e-6,
      }, { family: 'clipPart', part: 0, sourceCurved, clipExecuted: true, pass: true, gated: false }] : []) }];
    const actual = [{ model: 'source.ifc', id: 7, status: 'published', volumeM3: 1 + gap }];
    return compare(native, actual, native, t.nativeWasmVolumeRelative, scoped);
  };
  assert.ok(check(false, true, 1e-8).violations.length, 'planar clipped row stays strict');
  assert.ok(check(true, false, 1e-8).violations.length, 'unclipped curve stays strict');
  assert.ok(check(false, false, 1e-8).violations.length, 'unclipped planar row stays strict');
  assert.ok(check(true, true, 1e-8, false).violations.length, 'failed source oracle cannot qualify');
  const accepted = check(true, true, 2.85e-8);
  assert.deepEqual(accepted.violations, []);
  assert.deepEqual(accepted.scopedVolumeRows.map(r => [r.product, r.limit]), [['source.ifc#7', 1e-7]]);
  assert.ok(check(true, true, 2e-7).violations.length, 'curved clip remains bounded');
});

// #7955 round 7: product-level mixtures and skipped operations cannot inherit
// the exception from unrelated source geometry or a merely authored plane.
for (const [name, parts] of [
  ['unclipped round plus clipped planar box', [
    { sourceCurved: true, clipExecuted: false },
    { sourceCurved: false, clipExecuted: true },
  ]],
  ['curved host with bounds-skipped clip', [{ sourceCurved: true, clipExecuted: false }]],
  // A product volume cannot attribute its gap to the one qualified part, so
  // a qualified curved clip beside an unclipped round part must not widen.
  ['clipped round plus unclipped round', [
    { sourceCurved: true, clipExecuted: true },
    { sourceCurved: true, clipExecuted: false },
  ]],
]) {
  test(`#7955 M5 ${name} stays at 1e-9`, () => {
    const checks = parts.map((part, index) => ({ family: 'clipPart', part: index,
      ...part, gated: false, pass: true, value: 0, limit: 0 }));
    // Even a passing curved section result cannot widen these products.
    checks.push({ family: 'clipSectionVolumeRelative', sourceCurved: true,
      gated: true, pass: true, value: 0, limit: 2e-3 });
    const native = [{ model: 'mixed.ifc', id: 13, status: 'published', code: '',
      volume_m3: '1', src_oracle: JSON.stringify(checks) }];
    const actual = [{ model: 'mixed.ifc', id: 13, status: 'published', volumeM3: 1 + 1e-8 }];
    const result = compare(native, actual, native, 1e-9, 1e-7);
    assert.match(result.violations.join('\n'), /volume relative/);
    assert.deepEqual(result.scopedVolumeRows, []);
  });
}
