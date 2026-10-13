/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node mock-validate-cost.mjs <ids dist> [<ids dist> ...]
// #7537: validateIDS on the same mock accessor as filter-cost.mjs (300,000 walls and one
// door), with 1 and 20 specifications that select IFCWALL, IFCDOOR and require the Name
// attribute. Every entity check here costs almost nothing, so the filter's share of the run
// is far larger than on a parsed model: this bounds the overhead from above and is not
// end-to-end performance. Builds run interleaved, the order rotated each round, median of 9
// (1 specification) or 5 (20) after 3 warm-ups.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dists = process.argv.slice(2);
const builds = await Promise.all(
  dists.map(async (d) => ({ name: d, ...(await import(pathToFileURL(resolve(d, 'index.js')).href)) })),
);

const WALLS = 300_000;
const walls = Array.from({ length: WALLS }, (_, i) => i + 1);
const door = WALLS + 1;
const accessor = {
  getSchemaVersion: () => 'IFC4',
  getEntitiesByType: (t) => (t.toUpperCase() === 'IFCWALL' ? walls : t.toUpperCase() === 'IFCDOOR' ? [door] : []),
  getAllEntityIds: () => [...walls, door],
  getEntityType: (id) => (id === door ? 'IfcDoor' : 'IfcWall'),
  getEntityName: () => 'W', getGlobalId: () => undefined, getDescription: () => undefined,
  getObjectType: () => undefined, getPropertyValue: () => undefined, getPropertySets: () => [],
  getClassifications: () => [], getMaterials: () => [], getParent: () => undefined, getAttribute: () => undefined,
};
const spec = (i) => ({
  id: `s${i}`, name: `s${i}`, ifcVersions: ['IFC4'], minOccurs: 0, maxOccurs: 'unbounded',
  applicability: { facets: [{ type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', 'IFCDOOR'] } }] },
  requirements: [{ id: 'r', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } }, optionality: 'required' }],
});
const info = { modelId: 'mock', schemaVersion: 'IFC4', entityCount: WALLS + 1 };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const [n, rounds] of [[1, 9], [20, 5]]) {
  const doc = { info: { title: 'mock' }, specifications: Array.from({ length: n }, (_, i) => spec(i)) };
  const run = async (b) => (await b.validateIDS(doc, accessor, info, { includePassingEntities: false }))
    .specificationResults.map((s) => `${s.status} ${s.applicableCount}`);
  const results = [];
  for (const b of builds) results.push(await run(b));
  for (let i = 0; i < 3; i++) for (const b of builds) await run(b);
  const times = builds.map(() => []);
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < builds.length; k++) {
      const i = (k + r) % builds.length;
      const t = performance.now();
      await run(builds[i]);
      times[i].push(performance.now() - t);
    }
  }
  console.log(`${n} specification${n === 1 ? '' : 's'} (IFCWALL, IFCDOOR; Name required), mock accessor:`);
  builds.forEach((b, i) => console.log(`  ${b.name}: ${median(times[i]).toFixed(0)} ms; each specification ${[...new Set(results[i])].join(', ')}`));
}
