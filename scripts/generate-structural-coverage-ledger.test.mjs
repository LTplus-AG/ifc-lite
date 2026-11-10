#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the structural coverage scorecard (#9668): the derived
 * catalogue, the not-applicable rules, scoring and the ratchet
 * (`tests/structural-coverage/score.mjs`), the independent STEP reader, and
 * `scripts/generate-structural-coverage-ledger.mjs` (the committed ledger is
 * current; mismatched, empty or offline summaries are refused).
 * Needs neither fixtures nor built packages.
 *
 * Run: node --test scripts/generate-structural-coverage-ledger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, deriveCatalogue, notApplicable } from '../tests/structural-coverage/catalogue.mjs';
import { ratchet, runProbes, score } from '../tests/structural-coverage/score.mjs';
import { readStep } from '../tests/structural-coverage/lib/step.mjs';
import { unwritten } from '../tests/structural-coverage/probes/index.mjs';
import { SCENE, stepsFor } from '../tests/structural-coverage/probes/create-scene.mjs';
import { nonConforming } from '../tests/structural-coverage/probes/convert.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(ROOT, 'scripts/generate-structural-coverage-ledger.mjs');
const { rows } = deriveCatalogue(ROOT);
const byId = new Map(rows.map((r) => [r.id, r]));

test('catalogue: derived per schema from the generated tables, schema differences included', () => {
  assert.ok(byId.has('IFC4/IfcStructuralSurfaceAction'));
  assert.ok(!byId.has('IFC2X3/IfcStructuralSurfaceAction'), 'IFC2X3 has no surface action');
  assert.ok(byId.has('IFC2X3/IfcRelConnectsStructuralElement'));
  assert.ok(!byId.has('IFC4/IfcRelConnectsStructuralElement'), 'removed in IFC4');
  assert.ok(byId.has('IFC4X3/IfcConnectionPointEccentricity'));
  assert.ok(!byId.has('IFC4/IfcConnectionSurfaceGeometry'), 'only the eccentricity is taken from IfcConnectionGeometry');
  assert.ok(!rows.some((r) => r.entity === 'IfcStructuralItem'), 'abstract entities are not rows');
  assert.deepEqual(byId.get('IFC4/IfcStructuralLoadTemperature').own, ['Name', 'DeltaTConstant', 'DeltaTY', 'DeltaTZ']);
  assert.deepEqual(byId.get('IFC2X3/IfcStructuralLoadTemperature').own, ['Name', 'DeltaT_Constant', 'DeltaT_Y', 'DeltaT_Z']);
});

test('create scene: in every schema, each need runs earlier and each expected value names an attribute of that entity', () => {
  const { tables } = deriveCatalogue(ROOT);
  const bad = [];
  for (const schema of Object.keys(tables)) {
    const ran = new Set();
    for (const step of stepsFor(schema)) {
      for (const need of step.needs ?? []) if (!ran.has(need)) bad.push(`${step.id}: needs ${need}, which does not run before it in ${schema}`);
      ran.add(step.id);
      for (const [entity, expect] of Object.entries(step.emits)) {
        const attrs = tables[schema].table.get(entity)?.attributes;
        if (!attrs) { bad.push(`${step.id}: ${schema} has no ${entity}`); continue; }
        const { unchecked = [], ...values } = expect;
        for (const attr of [...Object.keys(values), ...unchecked]) if (!attrs.includes(attr)) bad.push(`${step.id}: ${schema} ${entity} has no ${attr}`);
      }
    }
  }
  assert.ok(SCENE.length > 0);
  assert.deepEqual(bad, []);
});

test('not-applicable rules are by family and schema, never per row', () => {
  const na = (id, level) => notApplicable(byId.get(id), level) !== null;
  assert.equal(na('IFC4/IfcStructuralLoadSingleForce', 'render'), true, 'resources are not rendered');
  assert.equal(na('IFC4/IfcStructuralPointAction', 'render'), false);
  assert.equal(na('IFC4/IfcRelConnectsStructuralMember', 'card'), true);
  assert.equal(na('IFC4X3/IfcStructuralCurveMember', 'convert'), true);
  assert.equal(na('IFC2X3/IfcStructuralCurveMember', 'convert'), false);
  assert.equal(na('IFC4/IfcStructuralCurveAction', 'convert'), false, 'kept: the converter may map and restore it');
  assert.equal(na('cap/docs-page', 'read'), true);
  assert.equal(na('cap/docs-page', 'capability'), false);
});

const two = [byId.get('IFC4/IfcStructuralPointAction'), byId.get('cap/docs-page')];
const cellsOf = (statuses) => new Map(two.map((r) => [r.id, Object.fromEntries(LEVELS.filter((l) => !notApplicable(r, l)).map((l) => [l, { status: statuses[r.id]?.[l] ?? 'fail', probe: 'p' }]))]));

test('score: pass 1, partial 0.5, skip and unwritten 0; met needs every applicable cell', () => {
  const all = Object.fromEntries(LEVELS.map((l) => [l, 'pass']));
  const s = score(two, cellsOf({ [two[0].id]: { ...all, card: 'partial', edit: 'skip', remove: 'unwritten' }, [two[1].id]: { capability: 'pass' } }));
  const action = s.rows[0];
  assert.equal(action.max, 8);
  assert.equal(action.points, 5.5);
  assert.equal(action.status, 'partial');
  assert.equal(s.rows[1].status, 'met');
  assert.deepEqual([s.total.score, s.total.max, s.cells.score, s.cells.max], [1.5, 2, 6.5, 9]);
  assert.equal(s.levels.edit.skip, 1);
  assert.equal(score(two, cellsOf({})).total.missing, 2, 'all fail is missing');
});

test('score: an empty denominator is refused', () => {
  assert.throws(() => score([], new Map()), /empty denominator/);
});

test('runProbes: an applicable cell with no probe is an error, and a probe that throws scores error', async () => {
  await assert.rejects(runProbes(two, {}, []), /no probe registered/);
  const boom = { name: 'boom', level: 'capability', async run() { throw new Error('x'); } };
  const covering = LEVELS.map((l) => unwritten(l, `todo:${l}`, 'later'));
  const cells = await runProbes(two, {}, [boom, ...covering]);
  assert.equal(cells.get('cap/docs-page').capability.status, 'error', 'error ranks above unwritten');
  assert.equal(cells.get(two[0].id).read.status, 'unwritten');
});

test('ratchet: fails on a drop in the total, a row, a cell, a changed row set, or an offline run', () => {
  const all = Object.fromEntries(LEVELS.map((l) => [l, 'pass']));
  const base = score(two, cellsOf({ [two[0].id]: { ...all, card: 'partial' }, [two[1].id]: { capability: 'pass' } }));
  assert.deepEqual(ratchet(base, base), []);
  const cellDrop = score(two, cellsOf({ [two[0].id]: { ...all, card: 'fail', edit: 'partial' }, [two[1].id]: { capability: 'pass' } }));
  assert.ok(ratchet(base, cellDrop).some((p) => p.includes('card: partial -> fail')), 'a cell drop fails even when the row status holds');
  const rowDrop = score(two, cellsOf({ [two[0].id]: { ...all, card: 'partial' } }));
  assert.ok(ratchet(base, rowDrop).some((p) => p.includes('cap/docs-page: met -> missing')));
  assert.ok(ratchet(base, rowDrop).some((p) => p.startsWith('total dropped')));
  const fewer = score([two[0]], cellsOf({ [two[0].id]: { ...all, card: 'partial' } }));
  assert.ok(ratchet(base, fewer).some((p) => p.includes('row is gone')));
  assert.ok(ratchet(fewer, base).some((p) => p.includes('rows not in the baseline')));
  assert.ok(ratchet(base, { ...base, offline: true, absent: ['a.ifc'] }).some((p) => p.includes('offline')));
});

test('STEP reader: typed values with a space, comments, escapes and every record', () => {
  const step = readStep(`ISO-10303-21;\nHEADER;FILE_SCHEMA (('IFC2X3'));ENDSEC;\nDATA;\n/* c; */ #1= IFCSIUNIT (*, .LENGTHUNIT., $, .METRE.);\n#2=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE (0.0174),#1);\n#3=IFCLABEL('a;''b\\X2\\00E4\\X0\\');\n#4=IFCX((1.E-05,-2.),.T.);\nENDSEC;END-ISO-10303-21;`);
  assert.equal(step.schema, 'IFC2X3');
  assert.equal(step.entities.size, 4);
  assert.deepEqual(step.get(2).args[0], { type: 'IFCPLANEANGLEMEASURE', value: 0.0174 });
  assert.equal(step.get(3).args[0], "a;'bä");
  assert.deepEqual(step.get(4).args, [[1e-5, -2], { enum: 'T' }]);
});

test('convert (#9668): a record copied into a schema that lacks the entity, with the wrong arity, or with a value that does not fit its slot, does not conform', () => {
  const { tables } = deriveCatalogue(ROOT);
  const ifc4 = readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCRELCONNECTSSTRUCTURALELEMENT('0',$,$,$,#2,#3);
#4=IFCSTRUCTURALLOADGROUP('1',$,$,$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD_LOAD_G.,1.,$);
#5=IFCSTRUCTURALLOADGROUP('2',$,$,$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD_LOAD_G.,1.);
ENDSEC;END-ISO-10303-21;`);
  const table = tables.IFC4.table;
  assert.equal(nonConforming(ifc4, 'IfcRelConnectsStructuralElement', table).length, 1, 'IFC4 has no such entity');
  assert.deepEqual(nonConforming(ifc4, 'IfcStructuralLoadGroup', table).map((r) => r.id), [5], 'only the short record');
  // A two-schema registry in the parser's SchemaRegistry shape: X is a SELECT slot, Y a defined-type slot.
  const registry = {
    entities: { IfcBoundaryNodeCondition: { attributes: [{ name: 'Name', type: 'IfcLabel' }, { name: 'X', type: 'IfcSel' }, { name: 'Y', type: 'IfcMeasure' }, { name: 'A', type: 'IfcMeasure' }, { name: 'B', type: 'IfcMeasure' }, { name: 'C', type: 'IfcMeasure' }, { name: 'D', type: 'IfcMeasure' }] } },
    selects: { IfcSel: ['IfcBoolean', 'IfcMeasure'] }, types: { IfcMeasure: 'REAL', IfcLabel: 'STRING' }, enums: {},
  };
  const bc = readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCBOUNDARYNODECONDITION('ok',IFCBOOLEAN(.T.),1.,$,$,$,$);
#2=IFCBOUNDARYNODECONDITION('bare in select',1.,1.,$,$,$,$);
#3=IFCBOUNDARYNODECONDITION('typed in measure',IFCBOOLEAN(.T.),IFCBOOLEAN(.T.),$,$,$,$);
ENDSEC;END-ISO-10303-21;`);
  const found = nonConforming(bc, 'IfcBoundaryNodeCondition', table, registry);
  assert.deepEqual(found.map((r) => r.id), [2, 3]);
  assert.match(found[0].why, /bare value in SELECT IfcSel/);
  assert.match(found[1].why, /typed IFCBOOLEAN in IfcMeasure/);
});

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'structural-ledger-'));
  for (const p of ['tests/structural-coverage', 'scripts/lib', 'packages/data/src/ifc-schema/generated', 'docs/architecture']) mkdirSync(join(dir, p), { recursive: true });
  cpSync(join(ROOT, 'tests/structural-coverage'), join(dir, 'tests/structural-coverage'), { recursive: true });
  cpSync(join(ROOT, 'scripts/lib'), join(dir, 'scripts/lib'), { recursive: true });
  cpSync(join(ROOT, 'packages/data/src/ifc-schema/generated'), join(dir, 'packages/data/src/ifc-schema/generated'), { recursive: true });
  return dir;
}
const run = (args) => spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });

test('ledger: the committed ledger is current', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.stderr);
});

test('ledger: a summary that disagrees with the catalogue, an empty one or an offline one is refused', () => {
  const dir = tree();
  try {
    const baseline = join(dir, 'tests/structural-coverage/baseline/r0.json');
    const summary = JSON.parse(readFileSync(baseline, 'utf8'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...summary, rows: summary.rows.slice(1) }));
    assert.match(run(['--root', dir, '--summary', bad]).stderr, /does not match the derived catalogue/);
    writeFileSync(bad, JSON.stringify({ ...summary, rows: [] }));
    assert.match(run(['--root', dir, '--summary', bad]).stderr, /no rows/);
    writeFileSync(bad, JSON.stringify({ ...summary, offline: true, absent: ['x.ifc'] }));
    assert.match(run(['--root', dir, '--summary', bad]).stderr, /scored offline/);
    assert.notEqual(run(['--root', dir, '--check']).status, 0, 'a tree with no committed ledger is stale');
    assert.equal(run(['--root', dir]).status, 0, 'the real baseline renders');
    assert.equal(run(['--root', dir, '--check']).status, 0, 'and is then current');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
