/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runInNewContext } from 'node:vm';
import { generateValidators } from '@ifc-lite/codegen';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as zod from 'zod';
import * as runtime from '../src/runtime/index.js';
import { validateStepText } from '../src/index.js';

function generated(source: string) {
  const { files, coverage } = generateValidators(source);
  const modules = new Map<string, Record<string, unknown>>([['zod', zod], ['@ifc-lite/validate/runtime', runtime]]);
  function load(name: string): Record<string, unknown> {
    const existing = modules.get(name);
    if (existing) return existing;
    const file = name.replace('./', '').replace(/\.js$/, '.ts');
    const { outputText } = ts.transpileModule(files[file], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    const exports = {};
    modules.set(name, exports);
    runInNewContext(outputText, { exports, require: load });
    return exports;
  }
  return { coverage, schemas: load('./zod.js') as Record<string, zod.ZodType>, schema: load('./index.js').SCHEMA as runtime.SchemaRuntime };
}

it('applies resolved ARRAY index bounds and preserves unresolved bounds in generated safeParse (#11559, #11560)', () => {
  const { schemas, coverage, schema } = generated(`SCHEMA S;
CONSTANT L : INTEGER := 3; END_CONSTANT;
TYPE UnknownArray = ARRAY [L:5] OF REAL; END_TYPE;
TYPE Triple = ARRAY [3:5] OF REAL; WHERE First : SELF[3] > 0; END_TYPE;
TYPE Alias = Triple; END_TYPE; END_SCHEMA;`);
  expect(coverage.unsupported.some(u => u.label === 'UnknownArray lower bound')).toBe(true);
  expect(schema.type('UnknownArray')).toMatchObject({ underlying: { high: 5 } });
  expect(schemas.UnknownArray.safeParse([1, 0, -1]).success).toBe(true);
  for (const type of [schemas.Triple, schemas.Alias]) {
    expect(type.safeParse([1, 0, -1]).success).toBe(true);
    expect(type.safeParse([-1, 0, 1]).success).toBe(false);
    expect(type.safeParse([1, 0]).success).toBe(false);
  }
});

it('evaluates enum and SELECT WHERE rules once for each applicable STEP value (#11560)', async () => {
  const { schema } = generated(`SCHEMA S;
TYPE E = ENUMERATION OF (YES, NO); WHERE Allowed : SELF = E.YES; END_TYPE;
TYPE Choice = SELECT (E); WHERE Allowed : SELF = E.YES; END_TYPE;
ENTITY Sample; Direct : E; Selected : Choice; END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=SAMPLE(.YES.,E(.YES.));#2=SAMPLE(.NO.,E(.NO.));ENDSEC;', { schema });
  const rules = report.findings.filter(f => f.category === 'simpletype_rule');
  expect(rules.map(f => [f.instance, f.rule])).toEqual([[2, 'E.Allowed'], [2, 'Choice.Allowed'], [2, 'E.Allowed']]);
  expect(report.stats.typeRuleEvaluations).toBe(6);
});

it('reads colliding attributes through the named group of a multiple-parent entity', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY A; X : REAL; END_ENTITY; ENTITY B; X : REAL; END_ENTITY;
ENTITY C SUBTYPE OF (A,B); WHERE Different : SELF\\A.X <> SELF\\B.X; END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=C(1.,2.);#2=C(1.,1.);ENDSEC;', { schema });
  expect(report.findings.filter(f => f.rule === 'C.Different').map(f => f.instance)).toEqual([2]);
});

it('compares entity attributes with their declared SET or LIST semantics (#11560)', async () => {
  for (const [kind, expected] of [['SET', [6]], ['LIST', [3, 6]]] as const) {
    const { schema } = generated(`SCHEMA S; TYPE Members = ${kind} [1:?] OF INTEGER; END_TYPE;
ENTITY Bucket; Items : Members; END_ENTITY;
ENTITY Pair; A : Bucket; B : Bucket; WHERE Equal : A = B; Distinct : A :<>: B; END_ENTITY; END_SCHEMA;`);
    const report = await validateStepText('DATA;#1=BUCKET((1,2));#2=BUCKET((2,1));#3=PAIR(#1,#2);#4=BUCKET((1,3));#6=PAIR(#1,#4);ENDSEC;', { schema });
    expect(report.findings.filter(f => f.rule === 'Pair.Equal').map(f => f.instance)).toEqual(expected);
    expect(report.findings.filter(f => f.rule === 'Pair.Distinct')).toEqual([]);
  }
});

it('checks declared BINARY widths in bits in generated authoring schemas', () => {
  const { schemas } = generated('SCHEMA S; TYPE Octet = BINARY(8) FIXED; END_TYPE; TYPE Short = BINARY(5); END_TYPE; END_SCHEMA;');
  expect(schemas.Octet.safeParse('0FF').success).toBe(true);
  expect(schemas.Octet.safeParse('0F').success).toBe(false);
  expect(schemas.Short.safeParse('0F').success).toBe(true);
  expect(schemas.Short.safeParse('0FF').success).toBe(false);
});

it('validates padding bits before width for STEP and generated authoring BINARY values', async () => {
  const { schemas, schema } = generated(`SCHEMA S; TYPE Bits = BINARY; END_TYPE;
TYPE Five = BINARY(5); END_TYPE; TYPE Fixed = BINARY(5) FIXED; END_TYPE;
ENTITY Sample; A : Bits; B : Five; C : Fixed; END_ENTITY; END_SCHEMA;`);
  for (const type of [schemas.Bits, schemas.Five, schemas.Fixed]) {
    expect(type.safeParse('31F').success).toBe(true);
    expect(type.safeParse('3FF').success).toBe(false);
  }
  const report = await validateStepText('DATA;#1=SAMPLE("31F","31F","31F");#2=SAMPLE("3FF","3FF","3FF");ENDSEC;', { schema });
  expect(report.findings.filter(f => f.rule === 'invalid-type').map(f => f.instance)).toEqual([2, 2, 2]);
});

it('distinguishes integral REAL and INTEGER STEP tokens in TYPEOF (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY Sample; N : NUMBER;
WHERE IsReal : 'REAL' IN TYPEOF(N); IsInteger : 'INTEGER' IN TYPEOF(N); END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=SAMPLE(5.);#2=SAMPLE(5);#3=SAMPLE(5.25);ENDSEC;', { schema });
  expect(report.findings.filter(f => f.category === 'entity_rule').map(f => [f.instance, f.rule])).toEqual([
    [1, 'Sample.IsInteger'], [2, 'Sample.IsReal'], [3, 'Sample.IsInteger'],
  ]);
});

it('counts every referencing role in the USEDIN bag (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY Item;
WHERE Twice : SIZEOF(USEDIN(SELF, '')) = 2;
 FirstRole : SIZEOF(USEDIN(SELF, 'S.Link.First')) = 1; END_ENTITY;
ENTITY Link; First : Item; Second : Item; END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=ITEM();#2=ITEM();#3=ITEM();#4=LINK(#1,#1);#5=LINK(#2,#3);ENDSEC;', { schema });
  expect(report.findings.filter(f => f.category === 'entity_rule').map(f => [f.instance, f.rule])).toEqual([
    [2, 'Item.Twice'], [3, 'Item.Twice'], [3, 'Item.FirstRole'],
  ]);
});
