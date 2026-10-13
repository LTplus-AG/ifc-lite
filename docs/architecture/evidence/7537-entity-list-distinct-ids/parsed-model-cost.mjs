/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node parsed-model-cost.mjs <walls> <specifications> <ids dist> [<ids dist> ...]
// #7537: validateIDS on a parsed model. Parsing is not timed: each sample is
// createDataAccessor plus validateIDS. The model is generated here: an IFC4 project with
// <walls> walls, one door, and Pset_WallCommon.IsExternal on every wall through one
// IfcRelDefinesByProperties. Each of the <specifications> specifications selects the
// entity list IFCWALL, IFCDOOR and requires Pset_WallCommon.IsExternal, so every wall
// passes and the door fails. The model is parsed once with IfcParser.parseColumnar (this
// checkout's packages/parser/dist) and read through each build's createDataAccessor. The
// IDS is passed as a document object. Builds run interleaved, the order rotated each round,
// median of 7 after 2 warm-ups; each build's results are printed beside its time.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [wallsArg, specsArg, ...dists] = process.argv.slice(2);
const WALLS = Number(wallsArg);
const SPECS = Number(specsArg);
const { IfcParser } = await import(new URL('../../../../packages/parser/dist/index.js', import.meta.url).href);
const builds = await Promise.all(
  dists.map(async (d) => ({
    name: d,
    validateIDS: (await import(pathToFileURL(resolve(d, 'validation/validator.js')).href)).validateIDS,
    createDataAccessor: (await import(pathToFileURL(resolve(d, 'bridge/index.js')).href)).createDataAccessor,
  })),
);

const gid = (n) => String(n).padStart(22, '0');
const lines = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
  "FILE_NAME('cost.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
  "#4=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);", `#5=IFCPROPERTYSET('${gid(5)}',$,'Pset_WallCommon',$,(#4));`,
];
const wallRefs = [];
for (let i = 0; i < WALLS; i++) {
  lines.push(`#${100 + i}=IFCWALL('${gid(100 + i)}',$,'W',$,$,$,$,$,$);`);
  wallRefs.push(`#${100 + i}`);
}
lines.push(`#${100 + WALLS}=IFCDOOR('${gid(100 + WALLS)}',$,'D',$,$,$,$,$,$,$,$,$,$);`);
lines.push(`#${101 + WALLS}=IFCRELDEFINESBYPROPERTIES('${gid(101 + WALLS)}',$,$,$,(${wallRefs.join(',')}),#5);`);
lines.push('ENDSEC;', 'END-ISO-10303-21;');
const bytes = new TextEncoder().encode(lines.join('\n'));
const store = await new IfcParser().parseColumnar(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  { disableWorkerScan: true },
);

const c = (value) => ({ type: 'simpleValue', value });
const doc = {
  info: { title: 'cost' },
  specifications: Array.from({ length: SPECS }, (_, i) => ({
    id: `s${i}`, name: `s${i}`, ifcVersions: ['IFC4'], minOccurs: 0, maxOccurs: 'unbounded',
    applicability: { facets: [{ type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', 'IFCDOOR'] } }] },
    requirements: [{ id: 'r', optionality: 'required', facet: { type: 'property', propertySet: c('Pset_WallCommon'), baseName: c('IsExternal') } }],
  })),
};
const info = { modelId: 'cost', schemaVersion: store.schemaVersion, entityCount: store.entityCount };
const run = async (b) => (await b.validateIDS(doc, b.createDataAccessor(store), info, { includePassingEntities: false }))
  .specificationResults.map((s) => `${s.status} ${s.applicableCount}/${s.passedCount}/${s.failedCount}`);

const results = [];
for (const b of builds) results.push(await run(b));
for (let i = 0; i < 2; i++) for (const b of builds) await run(b);
const times = builds.map(() => []);
for (let r = 0; r < 7; r++) {
  for (let k = 0; k < builds.length; k++) {
    const i = (k + r) % builds.length;
    const t = performance.now();
    await run(builds[i]);
    times[i].push(performance.now() - t);
  }
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`${WALLS} walls and a door, ${SPECS} specification${SPECS === 1 ? "" : "s"} (IFCWALL, IFCDOOR; Pset_WallCommon.IsExternal required):`);
builds.forEach((b, i) => console.log(`  ${b.name}: ${median(times[i]).toFixed(0)} ms; each specification ${[...new Set(results[i])].join(', ')}`));
