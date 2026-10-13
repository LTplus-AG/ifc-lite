/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node past-set-limit.mjs <ids dist>
// #7537: filterByEntityFacet with more distinct ids than V8 allows one Set (2^24). A mock
// accessor returns ids 0 to 2^24 - 3 for IFCWALL, and five more ids plus a repeat of id 0
// for IFCDOOR: 2^24 + 3 distinct ids, listed as IFCWALL, IFCDOOR. Prints how many ids the
// filter returned with a checksum of them, or what it threw, and the process's peak memory.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dist = process.argv[2];
const { filterByEntityFacet } = await import(pathToFileURL(resolve(dist, 'index.js')).href);

const N = 2 ** 24 + 3;
const walls = new Array(N - 5);
for (let i = 0; i < walls.length; i++) walls[i] = i;
const doors = [N - 5, N - 4, N - 3, N - 2, N - 1, 0];
const accessor = {
  getSchemaVersion: () => 'IFC4',
  getEntitiesByType: (t) => (t.toUpperCase() === 'IFCWALL' ? walls : t.toUpperCase() === 'IFCDOOR' ? doors : []),
};
const facet = { type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', 'IFCDOOR'] } };
/** Peak resident set size of this process, in GB. */
const peakGb = () => (process.resourceUsage().maxRSS / 1024 / 1024).toFixed(2);
const t = performance.now();
try {
  const ids = filterByEntityFacet(facet, accessor);
  let sum = 0;
  for (const id of ids) sum += id;
  const ms = (performance.now() - t).toFixed(0);
  console.log(`${dist}: returned ${ids.length} ids (sum ${sum}, first ${ids[0]}, last ${ids[ids.length - 1]}) in ${ms} ms; peak memory ${peakGb()} GB`);
} catch (err) {
  console.log(`${dist}: threw ${err?.name}: ${err?.message} after ${(performance.now() - t).toFixed(0)} ms; peak memory ${peakGb()} GB`);
}
