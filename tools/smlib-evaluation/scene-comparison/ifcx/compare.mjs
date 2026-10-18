// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [base, candidate, output] = process.argv.slice(2);
if (!output) throw new Error('usage: node compare.mjs BASE_RECORDS CANDIDATE_RECORDS RECEIPT.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [];
for (const name of (await readdir(base)).filter(name => name.endsWith('.json') && name !== 'summary.json').sort()) {
  const left = await readFile(resolve(base, name));
  const right = await readFile(resolve(candidate, name));
  assert.deepEqual(JSON.parse(left), JSON.parse(right), `structured IFCX consumer mismatch: ${name}`);
  records.push({ name, baseSha256: sha256(left), candidateSha256: sha256(right), equal: true,
    baseRecord: resolve(base, name), candidateRecord: resolve(candidate, name) });
}
assert.equal(records.length, 7, 'all five scenes and two nonempty overlays must be compared');
const observed = JSON.parse(await readFile(resolve(candidate, 'summary.json')));
await writeFile(output, JSON.stringify({ baseRevision: '8acd0715a5ad266cd57808b9889f6549fbf93631',
  records, scenes: observed.summaries, scope: observed.scope,
  excludedFromEquality: observed.excludedFromEquality,
  limits: ['No viewer loadFile/store/GPU upload was executed.', 'No Rust geometry backend is invoked by this IFCX consumer.',
    'Remote schema import declarations are retained but not resolved by the current importer.',
    'These samples emit no UV or texture pixels; that channel is unqualified here.',
    'Bridge IFCX emits no georeferencing extension result; georeference preservation remains unqualified.',
    'PBR overlay source opinions are composed but do not change emitted mesh colors or yield texture pixels.'],
}, null, 2) + '\n');
console.log(`Actual IFCX consumer records: ${records.length}/${records.length} equal`);
