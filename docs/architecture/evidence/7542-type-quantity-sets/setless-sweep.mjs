/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node setless-sweep.mjs <walls> <runs> <ids dist> [<ids dist> ...]
// #7542: the cost of the per-store memo of a type's quantity sets on entities that hold no set
// at all. Such an entity reaches the direct type-object read in collectAllPropertySets. A
// property-only applicability makes validateIDS read every entity's sets, these included.
//
// Model, generated here: IFC4, <walls> IfcWall over 10 IfcWallType (one IfcRelDefinesByType
// each); each type holds Qto_WallBaseQuantities (Length, Height); each wall has an
// IfcLocalPlacement, an IfcAxis2Placement3D and an IfcCartesianPoint, which hold no set.
//
// Each measurement runs in its own node process (--expose-gc), so nothing from an earlier run
// is freed inside the window: run in one process, a previous run's store was sometimes freed
// there and the heap figure went 14.6 MB negative. The child parses the model
// (IfcParser.parseColumnar, not timed), creates the build's accessor, and times getPropertySets
// over the 3 x <walls> placement entities only: an isolated loop over the bridge, not
// validateIDS, with a cold JIT. The heap figure is heapUsed after the loop minus before it, each
// read after three gc() calls with a turn of the event loop between them, the store still alive:
// what the loop leaves behind. One warm-up round, then <runs> rounds; builds interleaved, the
// order rotated each round.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args[0] === '--child') {
  const [, wallsArg, dist] = args;
  const { IfcParser } = await import(new URL('../../../../packages/parser/dist/index.js', import.meta.url).href);
  const { createDataAccessor } = await import(pathToFileURL(resolve(dist, 'bridge/index.js')).href);
  const { bytes, setless } = model(Number(wallsArg));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const accessor = createDataAccessor(store);
  const settledHeap = async () => {
    for (let k = 0; k < 3; k++) { globalThis.gc(); await new Promise((r) => setImmediate(r)); }
    return process.memoryUsage().heapUsed;
  };
  const before = await settledHeap();
  const t = performance.now();
  let sets = 0;
  for (const e of setless) sets += accessor.getPropertySets(e).length;
  const ms = performance.now() - t;
  const mb = (await settledHeap() - before) / 1e6;
  if (store.entityCount < 0) throw new Error('keeps the store alive until here');
  process.stdout.write(JSON.stringify({ ms, mb, sets, swept: setless.length }));
} else {
  const [wallsArg, runsArg, ...dists] = args;
  const RUNS = Number(runsArg);
  const script = fileURLToPath(import.meta.url);
  const names = dists.map((d) => d.split(/[\\/]/).pop());
  const times = dists.map(() => []), heap = dists.map(() => []), sets = dists.map(() => 0);
  let swept = 0;
  for (let round = 0; round <= RUNS; round++) {
    for (let k = 0; k < dists.length; k++) {
      const i = (k + round) % dists.length;
      const child = spawnSync(process.execPath, ['--expose-gc', script, '--child', wallsArg, dists[i]], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error(`${names[i]}: exit ${child.status}\n${child.stderr}`);
      const r = JSON.parse(child.stdout);
      sets[i] = r.sets;
      swept = r.swept;
      if (round > 0) { times[i].push(r.ms); heap[i].push(r.mb); }
    }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`${wallsArg} walls, ${swept} set-less placement entities swept, one process per run, ${RUNS} runs after 1 warm-up round, node ${process.version}:`);
  names.forEach((n, i) => console.log(`  ${n}: getPropertySets loop median ${median(times[i]).toFixed(1)} ms (${times[i].map((x) => x.toFixed(0)).join(', ')}); `
    + `heap left behind median ${median(heap[i]).toFixed(1)} MB (${heap[i].map((x) => x.toFixed(1)).join(', ')}); sets returned ${sets[i]}`));
}

function model(walls) {
  const gid = (p, id) => p + String(id).padStart(22 - p.length, '0');
  const lines = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('setless.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));'];
  let id = 100;
  const TYPES = 10;
  const typeIds = [], byType = [], setless = [];
  for (let t = 0; t < TYPES; t++) {
    const typeId = id++, q = id++, l = id++, h = id++;
    typeIds.push(typeId);
    byType.push([]);
    lines.push(`#${q}=IFCELEMENTQUANTITY('${gid('0q', q)}',$,'Qto_WallBaseQuantities',$,$,(#${l},#${h}));`);
    lines.push(`#${l}=IFCQUANTITYLENGTH('Length',$,$,5.,$);`, `#${h}=IFCQUANTITYLENGTH('Height',$,$,3.,$);`);
    lines.push(`#${typeId}=IFCWALLTYPE('${gid('0t', typeId)}',$,'WT${t}',$,$,(#${q}),$,$,$,.STANDARD.);`);
  }
  for (let i = 0; i < walls; i++) {
    const w = id++, lp = id++, ax = id++, pt = id++;
    byType[i % TYPES].push(w);
    setless.push(pt, ax, lp);
    lines.push(`#${pt}=IFCCARTESIANPOINT((${i}.,0.,0.));`, `#${ax}=IFCAXIS2PLACEMENT3D(#${pt},$,$);`, `#${lp}=IFCLOCALPLACEMENT($,#${ax});`);
    lines.push(`#${w}=IFCWALL('${gid('0w', w)}',$,'W${i}',$,$,#${lp},$,$,$);`);
  }
  typeIds.forEach((t, k) => {
    const r = id++;
    lines.push(`#${r}=IFCRELDEFINESBYTYPE('${gid('0r', r)}',$,$,$,(${byType[k].map((w) => `#${w}`).join(',')}),#${t});`);
  });
  lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return { bytes: new TextEncoder().encode(lines.join('\n')), setless };
}
