/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import capabilities from '../tests/structural-coverage/probes/capabilities.mjs';
import { runProbes } from '../tests/structural-coverage/score.mjs';
import { readRow } from '../tests/structural-coverage/probes/read.mjs';
import { readStep } from '../tests/structural-coverage/lib/step.mjs';
import { deriveCatalogue } from '../tests/structural-coverage/catalogue.mjs';
import { loadPackages } from '../tests/structural-coverage/lib/packages.mjs';

const root = resolve(import.meta.dirname, '..');
const { tables } = deriveCatalogue(root);
const step = (body) => readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${body}ENDSEC;END-ISO-10303-21;`);

test('#9668 links: resolve every express id, require IfcElement and fixture GlobalId, count each fixture', async () => {
  const file = { path: 'links.ifc', schema: 'IFC4', step: step(`#1=IFCWALL('wall');#2=IFCSTRUCTURALCURVEMEMBER('member');#3=IFCRELASSIGNSTOPRODUCT('rel',$,$,$,(#2),$,#1);`) };
  const row = { id: 'cap/physical-analytical-link-read', kind: 'capability' };
  async function run(ids, type = 'IfcWall', guid = 'wall') {
    const info = { physicalElementIds: ids };
    const other = { ...file, path: 'legacy.ifc', schema: 'IFC2X3', step: step(`#1=IFCWALL('wall');#2=IFCSTRUCTURALCURVEMEMBER('member');` + Array.from({ length: 30 }, (_, i) => `#${i + 3}=IFCRELCONNECTSSTRUCTURALELEMENT('rel${i}',$,$,$,#1,#2);`).join('')) };
    const cache = new Map([
      ['read:links.ifc', { byId: new Map([[2, { family: 'item', info }]]) }],
      ['store:links.ifc', { entities: { getTypeName: (id) => id === 1 ? type : '', getGlobalId: () => guid } }],
    ]);
    const reverse = { ...file, path: 'reverse.ifc', step: step("#1=IFCWALL('wall');#2=IFCSTRUCTURALCURVEMEMBER('member');#3=IFCRELASSIGNSTOPRODUCT('rel',$,$,$,(#1),$,#2);") };
    cache.set('read:reverse.ifc', cache.get('read:links.ifc'));
    cache.set('store:reverse.ifc', cache.get('store:links.ifc'));
    cache.set('read:legacy.ifc', cache.get('read:links.ifc'));
    cache.set('store:legacy.ifc', cache.get('store:links.ifc'));
    return (await runProbes([row], { corpus: { files: [file, other, reverse] }, tables, cache }, [capabilities[0]])).get(row.id).capability;
  }
  const good = await run([1]);
  assert.equal(good.status, 'pass', good.reason);
  assert.deepEqual(good.counts, [{ path: 'links.ifc', checked: 1, held: 1 }, { path: 'legacy.ifc', checked: 30, held: 30 }, { path: 'reverse.ifc', checked: 1, held: 1 }]);
  for (const bad of [await run([999]), await run([1], 'IfcProject'), await run([1], 'IfcWall', 'other'), await run([]), await run([1, 999])]) {
    assert.equal(bad.status, 'fail');
  }
});

test('#9668 Axis: exact EXPRESS first, fallback retained, same name with wrong value fails', () => {
  const row = { entity: 'IfcStructuralCurveMember', root: 'IfcStructuralItem', family: 'item', rooted: true, attributes: ['GlobalId', 'Axis'], own: ['Axis'] };
  const file = { path: 'axis.ifc', sha256: 'a', step: step("#1=IFCSTRUCTURALCURVEMEMBER('g',#2);#2=IFCDIRECTION((0.,0.,1.));") };
  const run = (fields) => {
    const info = { globalId: 'g', ...fields };
    const ix = { byId: new Map([[1, { type: row.entity, info }]]), fields: new Map([[row.entity, new Set(Object.keys(info))]]) };
    return readRow(row, [{ file, ix }], tables.IFC4.types);
  };
  assert.equal(run({ Axis: 2 }).status, 'pass');
  assert.equal(run({ Axis: 3 }).status, 'partial');
  assert.equal(run({ Axis: { expressId: 2 } }).status, 'pass');
  assert.equal(run({ axis: { expressId: 2 } }).status, 'pass');
  assert.equal(run({ Axis: { expressId: 3 }, axis: { expressId: 2 } }).status, 'partial');
  assert.match(run({ Axis: { expressId: 3 } }).reason, /Axis wrong/); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
});

test('#9668 CI: ratchet runs in built fixture job even in fast PR lane', () => {
  const wf = parse(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'));
  const build = wf.jobs.build;
  const commands = build.steps.map((s) => s.run ?? '');
  const i = commands.findIndex((s) => s.includes('tests/structural-coverage/score.mjs --check tests/structural-coverage/baseline/')); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  assert.ok(i > commands.indexOf('pnpm build')); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  assert.ok(i > commands.indexOf('pnpm fixtures')); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  assert.equal(build.steps[i].if, undefined);
  assert.ok(!build.if.includes("lane != 'fast'")); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  const filter = wf.jobs.changes.steps.find((s) => s.uses?.startsWith('dorny/paths-filter')); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  const paths = parse(filter.with.filters).frontend;
  for (const path of ['packages/parser/src/a.ts', 'packages/create/src/a.ts', 'packages/export/src/a.ts', 'tests/structural-coverage/score.mjs', 'tests/models/manifest.json']) {
    assert.ok(paths.some((p) => p.endsWith('/**') ? path.startsWith(p.slice(0, -2)) : p === path), path); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  }
});

test('#9668 stale dist: rebuild failure aborts before importing old output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'structural-build-'));
  try {
    for (const p of ['parser', 'mutations', 'create', 'export']) {
      mkdirSync(join(dir, 'packages', p, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'packages', p, 'dist/index.js'), 'throw new Error("STALE OUTPUT IMPORTED");');
    }
    await assert.rejects(loadPackages(dir), /structural coverage package build failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#9668 gate remedy: each generator failure class has an actionable remedy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'structural-remedy-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(root, 'scripts/check-generated.mjs'), join(dir, 'scripts/check-generated.mjs'));
    const r = spawnSync(process.execPath, [join(dir, 'scripts/check-generated.mjs')], {
      encoding: 'utf8', env: { ...process.env, IFC_LITE_GENERATED_GATE: 'check:structural-coverage-ledger' },
    });
    assert.equal(r.status, 1);
    const output = r.stdout + r.stderr;
    for (const phrase of ['is stale', 'does not match the derived catalogue', 'stored totals or applicability disagree', 'was scored offline', 'no r<N>.json summary', 'cp tests/structural-coverage/.out/summary.json tests/structural-coverage/baseline/r<N>.json']) assert.ok(output.includes(phrase), phrase);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
