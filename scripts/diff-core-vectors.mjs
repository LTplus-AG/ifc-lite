/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8042: generate field-by-field expectations from the built TS engine.
// pnpm build --filter=@ifc-lite/diff && node scripts/diff-core-vectors.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { diffModels } from '../packages/diff/dist/index.js';

const entity = (key, ref, extra = {}) => ({ key, ref, ifcType: 'IfcWall', dataHash: 'd', ...extra });
const cases = [
  { name: 'empty', base: [], head: [] },
  { name: 'duplicates', base: [entity('b', 1), entity('a', 2), entity('b', 3, { dataHash: 'changed' })],
    head: [entity('b', 4, { dataHash: 'changed' }), entity('c', 5), entity('c', 6)] },
  ...['data', 'geometry', 'both', 'invalid'].flatMap(scope => [
    { name: `${scope}-signals`, options: { scope },
      base: [entity('a', 1, { geometryHash: '1', container: 'Level 1', components: { '\ue000': 'a' } })],
      head: [entity('a', 2, { dataHash: 'e', geometryHash: '2', container: 'Level 2', components: { '\u{10000}': 'b' } })] },
    { name: `${scope}-abstention`, options: { scope },
      base: [entity('a', 1, { geometryHash: '1' })], head: [entity('a', 2)] },
  ]),
  ...[undefined, [], [['b', 'a']], [['b', 'a'], ['c', 'a']], [['b', 'missing']], [['b', 'b']], [['b', '']]].map((keyAliases, i) => ({
    name: `aliases-${i}`, options: keyAliases === undefined ? {} : { keyAliases },
    base: [entity('a', 1)], head: [entity('b', 2), entity('c', 3)],
  })),
  { name: 'live-alias-target', options: { keyAliases: [['b', 'a']] },
    base: [entity('a', 1)], head: [entity('b', 2), entity('a', 3)] },
  { name: 'exclude-counterpart-hash', options: { excludeTypes: ['\ufeff ifcopeningelement ', '', '\u0085'] },
    base: [entity('a', 1, { geometryHash: '1' }), entity('b', 2, { geometryHash: '2' })],
    head: [entity('a', 3), entity('b', 4, { geometryHash: '2', ifcType: 'IfcOpeningElement' })] },
];
// Deterministic combinations include sparse geometry, duplicate keys, type
// changes, empty vs absent components and containers, and rejected aliases.
let seed = 8042;
const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const side = () => Array.from({ length: next(12) }, (_, ref) => entity(`k${next(8)}`, ref, {
  ifcType: ['IfcWall', 'IfcDoor', 'IfcOpeningElement'][next(3)], dataHash: `d${next(3)}`,
  ...(next(2) ? { geometryHash: String(next(4)) } : {}),
  ...(next(2) ? { components: next(2) ? {} : { 'attr:core': String(next(3)) } } : {}),
  ...(next(2) ? { container: ['', 'Level 1', 'Level 2'][next(3)] } : {}),
}));
for (let i = 0; i < 128; i++) cases.push({ name: `generated-${i}`, base: side(), head: side(), options: {
  scope: ['both', 'data', 'geometry'][next(3)], excludeTypes: next(2) ? [' IfcDoor '] : [],
  ...(next(2) ? { keyAliases: [['k0', 'k1'], ['k2', 'k1'], ['k3', 'k4']] } : {}),
} });
const vectors = cases.map(test => {
  const options = { ...test.options };
  if (options.keyAliases !== undefined) options.keyAliases = new Map(options.keyAliases);
  const result = diffModels(test.base, test.head, options);
  return { ...test, expected: { ...result, byKey: [...result.byKey],
    ...(result.appliedKeyAliases === undefined ? {} : { appliedKeyAliases: [...result.appliedKeyAliases] }) } };
});
const path = new URL('../rust/diff/tests/core_vectors.json', import.meta.url);
const text = `[\n${vectors.map(vector => JSON.stringify(vector)).join(',\n')}\n]\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) throw new Error('Core vectors differ from the built TypeScript engine');
} else writeFileSync(path, text);
console.log(`Core parity: ${vectors.length} cases`);
