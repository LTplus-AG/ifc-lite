/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Manual probe, outside CI. Prepare dependencies through the root build first.
// Under exclusive fleet benchmark admission, from the repository root:
// TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --expose-gc --import tsx --import ./apps/viewer/src/test/vite-module-hooks.mjs apps/viewer/scripts/layer-grouping-perf.ts MAIN_SHA
// --check verifies variant shapes, reference decoding and row identity without timings.
import '../src/test/setup-dom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { IfcParser } from '@ifc-lite/parser';
import { buildPresentationLayerTree } from '../src/components/viewer/hierarchy/presentationLayerTree.js';

type Builder = typeof buildPresentationLayerTree;
const beforeCache = '6fdd8c0f3f908a2387fdbcb2ec9ec49217225652';
const main = process.argv[2];
assert.match(main ?? '', /^[0-9a-f]{40}$/, 'pass an explicit fetched main SHA');
const checkOnly = process.argv.includes('--check');
const hierarchy = 'apps/viewer/src/components/viewer/hierarchy';
const parserCopy = resolve('packages/parser/src/.layer-grouping-before-cache-resolver.ts');
const beforeCopy = resolve(hierarchy, '.layer-grouping-before-cache-tree.ts');
const mainCopy = resolve(hierarchy, '.layer-grouping-main-tree.ts');
const temporary = [parserCopy, beforeCopy, mainCopy];
const show = (sha: string, path: string) => execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8' });
const all = { has: () => true };
const cores = cpus().length;
const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());

/** Same overlapping-layer STEP setup as #9272's generated stress test. */
function fixture(count: number): ArrayBuffer {
  const ids = Array.from({ length: count }, (_, i) => 1000 + i);
  return new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCELEMENTASSEMBLY('assembly',$,'Assembly',$,$,$,#10,$,$,.NOTDEFINED.);
#2=IFCWALL('wall',$,'Wall',$,$,$,#11,$,$);
#3=IFCBUILDINGELEMENTPART('part',$,'Part',$,$,$,#12,$,$);
#4=IFCWALL('meshless',$,'Without mesh',$,$,$,#13,$,$);
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#30));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#31));
#22=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));
#23=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#33));
#30=IFCEXTRUDEDAREASOLID($,$,$,1.);
#31=IFCEXTRUDEDAREASOLID($,$,$,1.);
#32=IFCEXTRUDEDAREASOLID($,$,$,1.);
#33=IFCEXTRUDEDAREASOLID($,$,$,1.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Repeated',$,(#20,#20,#21),'A');
#51=IFCPRESENTATIONLAYERWITHSTYLE('Repeated',$,(#20),'B',.F.,.F.,.F.,());
#52=IFCPRESENTATIONLAYERASSIGNMENT('No geometry',$,(#23),$);
#53=IFCPRESENTATIONLAYERASSIGNMENT('Dangling',$,(#999),$);
#90=IFCRELAGGREGATES('aggregate',$,$,$,#1,(#3));
${ids.map(id => `#${id}=${id % 2 ? 'IFCDOOR' : 'IFCWALL'}('guid${id}',$,'Element ${id}',$,$,$,#11,$);`).join('\n')}
#63=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#64=IFCCLASSIFICATIONREFERENCE($,'EF_25','Walls',#63,$,$);
#65=IFCRELASSOCIATESCLASSIFICATION('stress',$,$,$,(${ids.filter(id => id % 2 === 0).map(id => `#${id}`).join(',')}),#64);
#66=IFCPRESENTATIONLAYERASSIGNMENT('Stress A',$,(#21),$);
#67=IFCPRESENTATIONLAYERASSIGNMENT('Stress B',$,(#21),$);
ENDSEC;
END-ISO-10303-21;`).buffer;
}

function cpu() {
  const values = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { total: values.reduce((sum, n) => sum + n, 0), idle: values[3] + values[4] };
}
async function idleSample() {
  const quiet: number[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const a = cpu();
    await new Promise(resolve => setTimeout(resolve, 2000));
    const b = cpu();
    const busy = 1 - (b.idle - a.idle) / (b.total - a.total);
    if (busy < 0.05) quiet.push(busy);
    else { quiet.length = 0; console.log(JSON.stringify({ kind: 'idle-deferral', attempt, busy })); }
    // Allow warm-up/GC to settle; keep the original idle threshold intact.
    if (quiet.length === 2) return Math.max(...quiet);
  }
  assert.fail('no two consecutive idle-host samples below 5%; no timing accepted');
}
function digest(rows: ReturnType<Builder>) {
  // Property insertion order is not a tree compatibility contract.
  const json = JSON.stringify(rows, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
  return { hash: createHash('sha256').update(json).digest('hex'), rows: rows.length };
}

assert.ok(temporary.every(path => !existsSync(path)), 'baseline files already exist; inspect their owner');
try {
  writeFileSync(parserCopy, show(beforeCache, 'packages/parser/src/classification-resolver.ts'));
  const parserImport = relative(dirname(beforeCopy), parserCopy).replace(/\.ts$/, '.js');
  writeFileSync(beforeCopy, show(beforeCache, `${hierarchy}/presentationLayerTree.ts`).replace(
    "import { extractClassificationsOnDemand, type IfcDataStore } from '@ifc-lite/parser';",
    `import type { IfcDataStore } from '@ifc-lite/parser';\nimport { extractClassificationsOnDemand } from '${parserImport}';`));
  writeFileSync(mainCopy, show(main, `${hierarchy}/presentationLayerTree.ts`));
  const before = (await import(pathToFileURL(beforeCopy).href)).buildPresentationLayerTree as Builder;
  const mainTree = (await import(pathToFileURL(mainCopy).href)).buildPresentationLayerTree as Builder;
  const result: { beforeCache: string; main: string; head: string; sizes: unknown[] } = {
    beforeCache, main, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sizes: [],
  };
  for (const count of checkOnly ? [12] : [12_000, 50_000]) {
    const store = await new IfcParser().parseColumnar(fixture(count), { disableWorkerScan: true });
    const variants = [
      { name: 'main-none', build: mainTree, mode: 'none' },
      { name: 'before-none', build: before, mode: 'none' },
      { name: 'after-none', build: buildPresentationLayerTree, mode: 'none' },
      { name: 'before-class', build: before, mode: 'class' },
      { name: 'after-class', build: buildPresentationLayerTree, mode: 'class' },
      { name: 'before-classification', build: before, mode: 'classification' },
      { name: 'after-classification', build: buildPresentationLayerTree, mode: 'classification' },
    ] as const;
    const run = (v: typeof variants[number]) => v.build(new Map(), store, all, new Set(), new Set(), undefined, v.mode);
    const hashes: Record<string, { hash: string; rows: number }> = {};
    const referenceReads: Record<string, number> = {};
    const original = store.getEntity;
    let reads = 0;
    store.getEntity = id => { if (id === 64) reads++; return original.call(store, id); };
    for (const v of variants) {
      reads = 0;
      const rows = run(v);
      referenceReads[v.name] = reads;
      const layer = rows.find(row => row.entityExpressId === 66);
      assert.ok(layer);
      const groups = rows.filter(row => row.type === 'type-group' && row.id.startsWith(layer.id));
      const names = v.mode === 'class' ? ['IfcDoor', 'IfcWall'] : ['Unclassified', 'Uniclass: EF_25'];
      assert.deepEqual(new Set(groups.map(row => row.name)), new Set(v.mode === 'none' ? [] : names), `${v.name}: mode actually selected`);
      assert.equal(rows.length, count * 3 + (v.mode === 'none' ? 11 : v.mode === 'class' ? 20 : 19));
      hashes[v.name] = digest(rows);
    }
    store.getEntity = original;
    assert.equal(referenceReads['before-classification'], count / 2, 'before-cache really decodes per product');
    assert.equal(referenceReads['after-classification'], 1, 'after-cache really reuses the shared reference');
    for (const mode of ['none', 'class', 'classification']) assert.deepEqual(hashes[`before-${mode}`], hashes[`after-${mode}`]);
    assert.deepEqual(hashes['main-none'], hashes['after-none'], 'main and branch preserve the same flat tree');
    if (!checkOnly) for (const v of variants) run(v); // warm normal, uninstrumented call sites
    const samples: { round: number; name: string; ms: number; busy: number; foreignBusy: number }[] = [];
    for (let round = 0; round < (checkOnly ? 0 : 5); round++) {
      const order = round % 2 ? [...variants].reverse() : variants;
      for (const v of order) {
        global.gc?.();
        const busy = await idleSample();
        const hostStart = cpu();
        const ownStart = process.cpuUsage();
        const start = performance.now();
        const rows = run(v);
        const ms = performance.now() - start;
        const own = process.cpuUsage(ownStart);
        const hostEnd = cpu();
        const hostSeconds = (hostEnd.total - hostStart.total - hostEnd.idle + hostStart.idle) / ticks;
        const foreignBusy = Math.max(0, hostSeconds - (own.user + own.system) / 1e6) / (ms / 1000 * cores);
        assert.ok(foreignBusy < 0.05, `${v.name}: competing CPU load during timing; reject cohort`);
        assert.equal(rows.length, hashes[v.name].rows);
        samples.push({ round, name: v.name, ms, busy, foreignBusy });
      }
    }
    const row = { count, hashes, referenceReads, samples };
    result.sizes.push(row);
    console.log(JSON.stringify(row));
  }
  console.log(JSON.stringify(result));
} finally {
  for (const path of temporary) rmSync(path, { force: true });
}
