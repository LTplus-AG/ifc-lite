/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Run under exclusive fleet benchmark admission, after the root viewer build:
// TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --expose-gc --import tsx --import ./apps/viewer/src/test/vite-module-hooks.mjs apps/viewer/scripts/layer-grouping-perf.ts BASE_SHA
import '../src/test/setup-dom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { IfcParser } from '@ifc-lite/parser';
import { buildPresentationLayerTree } from '../src/components/viewer/hierarchy/presentationLayerTree.js';

type Builder = typeof buildPresentationLayerTree;
const base = process.argv[2];
const checkOnly = process.argv.includes('--check');
assert.match(base ?? '', /^[0-9a-f]{40}$/);
const hierarchy = 'apps/viewer/src/components/viewer/hierarchy';
const parserCopy = resolve('packages/parser/src/.layer-grouping-base-resolver.ts');
const builderCopy = resolve(hierarchy, '.layer-grouping-base-tree.ts');
const show = (path: string) => execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' });
const all = { has: () => true };

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
  const a = cpu();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const b = cpu();
  const busy = 1 - (b.idle - a.idle) / (b.total - a.total);
  assert.ok(busy < 0.05, `host busy ${(busy * 100).toFixed(1)}%; no contaminated timing accepted`);
  return busy;
}

try {
  writeFileSync(parserCopy, show('packages/parser/src/classification-resolver.ts'));
  const parserImport = relative(dirname(builderCopy), parserCopy).replace(/\.ts$/, '.js');
  writeFileSync(builderCopy, show(`${hierarchy}/presentationLayerTree.ts`).replace(
    "import { extractClassificationsOnDemand, type IfcDataStore } from '@ifc-lite/parser';",
    `import type { IfcDataStore } from '@ifc-lite/parser';\nimport { extractClassificationsOnDemand } from '${parserImport}';`));
  const baseline = (await import(pathToFileURL(builderCopy).href)).buildPresentationLayerTree as Builder;
  const result: { base: string; head: string; sizes: unknown[] } = {
    base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sizes: [],
  };
  for (const count of checkOnly ? [12] : [12_000, 50_000]) {
    const store = await new IfcParser().parseColumnar(fixture(count), { disableWorkerScan: true });
    const variants = [
      { name: 'base-none', build: baseline, mode: 'none' },
      { name: 'branch-none', build: buildPresentationLayerTree, mode: 'none' },
      { name: 'base-classification', build: baseline, mode: 'classification' },
      { name: 'branch-classification', build: buildPresentationLayerTree, mode: 'classification' },
    ] as const;
    const run = (v: typeof variants[number]) => v.build(new Map(), store, all, new Set(), new Set(), undefined, v.mode);
    const hashes: Record<string, { hash: string; rows: number }> = {};
    for (const v of variants) {
      const rows = run(v); // warm schema/code and the shared-reference cache
      hashes[v.name] = { hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), rows: rows.length };
    }
    for (const mode of ['none', 'classification']) assert.deepEqual(hashes[`base-${mode}`], hashes[`branch-${mode}`]);
    const samples: { round: number; name: string; ms: number; busy: number }[] = [];
    for (let round = 0; round < (checkOnly ? 0 : 5); round++) {
      // Balanced, interleaved A/B: no all-base-then-all-branch cohort.
      for (const index of round % 2 ? [3, 2, 1, 0] : [0, 1, 2, 3]) {
        global.gc?.();
        const busy = await idleSample();
        const v = variants[index];
        const start = performance.now();
        const rows = run(v);
        const ms = performance.now() - start;
        assert.equal(rows.length, hashes[v.name].rows);
        samples.push({ round, name: v.name, ms, busy });
      }
    }
    const row = { count, hashes, samples };
    result.sizes.push(row);
    console.log(JSON.stringify(row));
  }
  console.log(JSON.stringify(result));
} finally {
  for (const path of [builderCopy, parserCopy]) unlinkSync(path);
}
