/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Regenerate from the preserved TypeScript oracle; Node 22.13 uses tsx explicitly.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDiffOracle } from './lib/diff-oracle.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const { buildDataFingerprint, buildComponentFingerprints } = await loadDiffOracle('fingerprint');
const strings = ['\ud800', '\udc00', '\ufffd', '\\ud800', '\ud800\udc00', '\ue000', 'a\ud800b\udc00c', '\ud800\ud800\udc00'];
const vectors = [];
function add(name, input) {
  vectors.push({ name, input, hash: buildDataFingerprint(input), components: Object.entries(buildComponentFingerprints(input)) });
}
for (const [index, value] of strings.entries()) {
  for (const field of ['ifcType', 'name', 'description', 'objectType', 'predefinedType', 'tag']) {
    add(`${field}-${index}`, { ifcType: 'IfcWall', [field]: value });
  }
  add(`all-collections-${index}`, {
    ifcType: value, materials: [' ', value, value], classifications: [value],
    typeAssignments: [{ name: value, type: value }],
    propertySets: [{ name: value, properties: [{ name: value, value }] }],
    quantitySets: [{ name: value, quantities: [{ name: value, value: { [value]: [value, { [value]: value }] } }] }],
  });
}
add('ordering-and-duplicates', {
  ifcType: 'IfcWall', materials: strings, classifications: [...strings].reverse(),
  propertySets: [...strings, strings[0]].map((name, i) => ({ name, properties: [{ name, value: i }] })),
  quantitySets: strings.map(name => ({ name, quantities: [{ name, value: { [strings[0]]: strings[1], [strings[5]]: name } }] })),
  typeAssignments: strings.map(name => ({ name, type: name })),
});
await writeFile(resolve(root, 'rust/diff/tests/fingerprint_utf16_vectors.json'), `[\n${vectors.map(vector => `  ${JSON.stringify(vector)}`).join(',\n')}\n]\n`);
console.log(`Recorded ${vectors.length} UTF-16 fingerprint vectors from the test-only TS oracle`);
