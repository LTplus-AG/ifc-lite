// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projections, drift, writeOutputs, validateSchema } from './generate.mjs';
import { schema } from './schema.mjs';

test('#7955 generator determinism and each missing/altered projection fail drift', async () => {
  const outputs = await projections();
  assert.deepEqual(await projections(), outputs);
  assert.equal(outputs.size, 6);
  const root = await mkdtemp(join(tmpdir(), 'retained-contract-'));
  try {
    await writeOutputs(root, outputs);
    assert.deepEqual(await drift(root, outputs), []);
    for (const path of outputs.keys()) {
      await appendFile(join(root, path), '\n// independent generator drift mutant\n');
      assert.deepEqual(await drift(root, outputs), [path]);
      await writeOutputs(root, outputs);
      await rm(join(root, path));
      assert.deepEqual(await drift(root, outputs), [path]);
      await writeOutputs(root, outputs);
    }
    assert.deepEqual(await drift(root, outputs), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('#7955 generator rejects unknown schema machinery instead of weakening it', () => {
  for (const mutate of [
    (s) => { s.version = 2; }, (s) => { s.types.Version.value = null; },
    (s) => { s.types.Hash.format = 'anything'; }, (s) => { s.types.Options.fields.extra = 'Unknown'; },
    (s) => { s.types.Options.fields.cycle = 'Options'; }, (s) => { s.types.Bool.kind = 'any'; },
    (s) => { s.types.Positive.max = Infinity; }, (s) => { s.types.Products.max = 1e9; },
    (s) => { s.types.Options.additionalProperties = true; }, (s) => { s.types.Code.values.push('ACCEPT'); },
  ]) {
    const changed = structuredClone(schema); mutate(changed);
    assert.throws(() => validateSchema(changed));
  }
});
