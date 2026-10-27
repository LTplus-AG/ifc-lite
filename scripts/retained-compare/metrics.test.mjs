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
