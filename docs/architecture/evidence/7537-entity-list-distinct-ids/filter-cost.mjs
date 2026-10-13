/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node filter-cost.mjs <ids dist> [<ids dist> ...]
// #7537: the cost of filterByEntityFacet alone, on a mock accessor with 300,000 walls and
// one door (ids 1 to 300,001). Each build is given as its packages/ids/dist folder. The
// builds run interleaved per round, median of 15 after 3 warm-ups. This is an isolated
// filter probe, not end-to-end performance: parsed-model-cost.mjs is closer to that.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dists = process.argv.slice(2);
const builds = await Promise.all(
  dists.map(async (d) => ({ name: d, ...(await import(pathToFileURL(resolve(d, 'index.js')).href)) })),
);

const WALLS = 300_000;
const walls = Array.from({ length: WALLS }, (_, i) => i + 1);
const door = [WALLS + 1];
const accessor = {
  getSchemaVersion: () => 'IFC4',
  getEntitiesByType: (t) => (t.toUpperCase() === 'IFCWALL' ? walls : t.toUpperCase() === 'IFCDOOR' ? door : []),
};
const facet = (...values) => ({ type: 'entity', name: { type: 'enumeration', values } });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const values of [['IFCWALL'], ['IFCWALL', 'IFCDOOR'], ['IFCWALL', 'IFCWALL']]) {
  const f = facet(...values);
  const counts = builds.map((b) => b.filterByEntityFacet(f, accessor).length);
  for (let i = 0; i < 3; i++) for (const b of builds) b.filterByEntityFacet(f, accessor);
  const times = builds.map(() => []);
  for (let r = 0; r < 15; r++) {
    builds.forEach((b, i) => {
      const t = performance.now();
      b.filterByEntityFacet(f, accessor);
      times[i].push(performance.now() - t);
    });
  }
  console.log(`[${values}]`);
  builds.forEach((b, i) => console.log(`  ${b.name}: ${counts[i]} ids, ${median(times[i]).toFixed(1)} ms`));
}
