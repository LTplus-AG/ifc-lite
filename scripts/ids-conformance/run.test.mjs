/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// IDS conformance dashboard (IDS-125): the CLI and the ifc-lite column.
// The ifc-lite adapter needs the built workspace; without it those tests
// skip (build with `pnpm turbo build --filter=@ifc-lite/ids...`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './run.mjs';
import { createIfcLiteAdapter } from './lib/adapters/ifc-lite.mjs';
import { discoverCorpus } from './lib/corpus.mjs';
import { runCell } from './lib/matrix.mjs';

const BUILT = existsSync(fileURLToPath(new URL('../../packages/ids/dist/index.js', import.meta.url)));
const CORPUS = fileURLToPath(new URL('../../packages/ids/src/__corpus__/buildingsmart-ids', import.meta.url));

test('arguments: engine configs repeat, unknown flags and missing values are refused', () => {
  const opts = parseArgs(['--engine-config', 'a.json', '--engine-config', 'b.json', '--limit', '5', '--no-doc']);
  assert.deepEqual([opts.engineConfigs, opts.limit, opts.doc], [['a.json', 'b.json'], 5, false]);
  assert.throws(() => parseArgs(['--engines', 'x']), /unknown argument --engines/);
  assert.throws(() => parseArgs(['--out']), /--out needs a value/);
});

test('the ifc-lite column answers both corpus questions', { skip: BUILT ? false : 'build @ifc-lite/ids first' }, async () => {
  const pick = (id) => discoverCorpus(CORPUS).find((c) => c.id === id);
  const adapter = await createIfcLiteAdapter();
  for (const id of ['entity/pass-a_matching_entity_should_pass', 'entity/fail-a_predefined_type_from_an_enumeration_must_be_uppercase']) {
    const c = pick(id);
    assert.ok(c, id);
    assert.deepEqual(await runCell(c, adapter), { verdict: c.expected, agrees: true }, id);
  }
  const invalid = pick('entity/invalid-entities_must_be_specified_as_uppercase_strings');
  assert.deepEqual(await runCell(invalid, adapter), { verdict: 'invalid', agrees: true });
  const preview = await createIfcLiteAdapter({ ids11: true });
  assert.equal(preview.info.id, 'ifc-lite-ids11-preview');
});
