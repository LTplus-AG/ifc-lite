/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { matchesAny } from './lib/ci-path-coverage.mjs';

const root = resolve(import.meta.dirname, '..');
const { tables } = deriveCatalogue(root);
const step = (body) => readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${body}ENDSEC;END-ISO-10303-21;`);

test('#9668 links: resolve every express id, require IfcElement and fixture GlobalId, count each fixture', async () => {
  // A storey assignment is not a physical link, so it is not counted.
  const file = { path: 'links.ifc', schema: 'IFC4', step: step(`#1=IFCWALL('wall');#2=IFCSTRUCTURALCURVEMEMBER('member');#3=IFCRELASSIGNSTOPRODUCT('rel',$,$,$,(#2),$,#1);#5=IFCBUILDINGSTOREY('storey');#6=IFCRELASSIGNSTOPRODUCT('rel2',$,$,$,(#2),$,#5);`) };
  // 30 distinct links (past the old 25-link sample) plus one duplicate relationship, counted once.
  const members = Array.from({ length: 30 }, (_, i) => 100 + i);
  const legacy = { ...file, path: 'legacy.ifc', schema: 'IFC2X3', step: step(`#1=IFCWALL('wall');${members.map((m) => `#${m}=IFCSTRUCTURALCURVEMEMBER('m${m}');#${m + 100}=IFCRELCONNECTSSTRUCTURALELEMENT('rel${m}',$,$,$,#1,#${m});`).join('')}#300=IFCRELCONNECTSSTRUCTURALELEMENT('dup',$,$,$,#1,#100);`) };
  const reverse = { ...file, path: 'reverse.ifc', step: step("#1=IFCWALL('wall');#2=IFCSTRUCTURALCURVEMEMBER('member');#3=IFCRELASSIGNSTOPRODUCT('rel',$,$,$,(#1),$,#2);") };
  const row = { id: 'cap/physical-analytical-link-read', kind: 'capability' };
  async function run(ids, type = 'IfcWall', guid = 'wall') {
    const item = { family: 'item', info: { physicalElementIds: ids } };
    // The probe must ask for the declared class; the coalesced family answers wrongly here.
    const store = { entities: { getExactTypeName: (id) => id === 1 ? type : id === 4 ? 'IFCWALL' : '', getTypeName: () => 'IfcProject', getGlobalId: (id) => id === 4 ? 'unlinked' : guid } };
    const read = { byId: new Map([[2, item]]) };
    const cache = new Map([['read:links.ifc', read], ['read:reverse.ifc', read], ['read:legacy.ifc', { byId: new Map(members.map((m) => [m, item])) }]]);
    for (const f of [file, legacy, reverse]) cache.set(`store:${f.path}`, store);
    return (await runProbes([row], { corpus: { files: [file, legacy, reverse] }, tables, cache }, [capabilities[0]])).get(row.id).capability;
  }
  const good = await run([1]);
  assert.equal(good.status, 'pass', good.reason);
  assert.equal((await run([1], 'IFCWALL')).status, 'pass', 'a STEP UPPERCASE type name still resolves');
  assert.deepEqual(good.counts, [{ path: 'links.ifc', checked: 1, held: 1 }, { path: 'legacy.ifc', checked: 30, held: 30 }, { path: 'reverse.ifc', checked: 1, held: 1 }]);
  for (const bad of [await run([999]), await run([1], 'IfcProject'), await run([1], 'IfcWall', 'other'), await run([]), await run([1, 999]), await run([1, 4])]) {
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
  // CI ratchets against the newest frozen baseline, the one the ledger renders.
  const newest = Math.max(...readdirSync(join(root, 'tests/structural-coverage/baseline')).map((f) => /^r(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number));
  assert.ok(commands[i].trim().endsWith(`baseline/r${newest}.json`), commands[i]); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  for (const before of ['pnpm build', 'pnpm fixtures:check']) {
    const j = commands.indexOf(before); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
    assert.ok(j >= 0 && i > j, before);
  }
  assert.equal(build.steps[i].if, undefined);
  assert.ok(!build.if.includes("lane != 'fast'")); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  const filter = wf.jobs.changes.steps.find((s) => s.uses?.startsWith('dorny/paths-filter')); // @source-text-assertion-ok parsed workflow configuration or probe verdict, not source text
  const paths = parse(filter.with.filters).frontend;
  for (const path of ['packages/parser/src/a.ts', 'packages/create/src/a.ts', 'packages/export/src/a.ts', 'tests/structural-coverage/score.mjs', 'tests/models/manifest.json', 'docs/guide/structural-analysis.md', 'scripts/lib/bounded-process.mjs', 'scripts/lib/entity-table.mjs', 'scripts/lib/rust-schema-names.mjs']) {
    assert.ok(matchesAny(path, paths), path);
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
    const gate = spawnSync(process.execPath, [join(dir, 'scripts/check-generated.mjs')], {
      encoding: 'utf8', env: { ...process.env, IFC_LITE_GENERATED_GATE: 'check:structural-coverage-ledger' },
    });
    assert.equal(gate.status, 1);
    const remedy = gate.stdout + gate.stderr;
    // Break the generator's input each way it refuses, and require the remedy to quote what it printed.
    const r1 = JSON.parse(readFileSync(join(root, 'tests/structural-coverage/baseline/r1.json'), 'utf8'));
    const write = (name, content) => { const p = join(dir, name); writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content)); return p; };
    const cases = [
      ['is stale', ['--summary', 'tests/structural-coverage/baseline/r0.json']],
      ['does not match the derived catalogue', ['--summary', write('rows.json', { ...r1, rows: r1.rows.slice(1) })]],
      ['stored totals or applicability disagree', ['--summary', write('forged.json', { ...r1, cells: { ...r1.cells, score: 300 } })]],
      ['was scored offline', ['--summary', write('offline.json', { ...r1, offline: true })]],
      ['no r<N>.json summary', ['--root', dir]],
      ['ledger: missing', ['--summary', join(dir, 'absent.json')]],
      ['is not JSON', ['--summary', write('text.json', 'not json')]],
      ['is not an', ['--summary', write('schema.json', { rows: r1.rows })]],
      ['has no rows', ['--summary', write('empty.json', { ...r1, rows: [] })]],
    ];
    for (const [phrase, args] of cases) {
      const r = spawnSync(process.execPath, [join(root, 'scripts/generate-structural-coverage-ledger.mjs'), '--check', ...args], { encoding: 'utf8', cwd: root });
      assert.equal(r.status, 1, phrase);
      assert.ok((r.stdout + r.stderr).includes(phrase), `${phrase}: ${r.stderr}`);
      assert.ok(remedy.includes(`"${phrase}"`), phrase);
    }
    assert.ok(remedy.includes('cp tests/structural-coverage/.out/summary.json tests/structural-coverage/baseline/r<N>.json'));
    assert.ok(remedy.includes('.github/workflows/test.yml'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
