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

it('retains INTEGER for EXPRESS literals and SIZEOF results (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY Sample; N : INTEGER;
WHERE LiteralInteger : 'INTEGER' IN TYPEOF(5);
LiteralReal : 'REAL' IN TYPEOF(5);
CountInteger : 'INTEGER' IN TYPEOF(SIZEOF([N]));
CountReal : 'REAL' IN TYPEOF(SIZEOF([N])); END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=SAMPLE(5);ENDSEC;', { schema });
  expect(report.findings.filter(f => f.category === 'entity_rule').map(f => f.rule)).toEqual(['Sample.LiteralReal', 'Sample.CountReal']);
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

it('checks aggregate-valued UNIQUE using the declared order semantics (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; TYPE Members = SET OF INTEGER; END_TYPE;
ENTITY E; Items : Members; Ordered : LIST OF INTEGER; UNIQUE US : Items; UL : Ordered; END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=E((1,2),(1,2));#2=E((2,1),(2,1));#3=E((3,4),(1,2));ENDSEC;', { schema });
  expect(report.findings.filter(f => f.category === 'unique_rule').map(f => [f.instance, f.rule])).toEqual([[2,'E.US'], [3,'E.UL']]);
});

it('runs authoring math and resolves the renamed explicit field (#11646)', () => {
  const { schemas } = generated(`SCHEMA S; ENTITY Point; X : REAL; END_ENTITY;
ENTITY IntPoint SUBTYPE OF (Point); SELF\\Point.X RENAMED IntegerX : INTEGER;
WHERE Positive : SIN(IntegerX) > 0.; END_ENTITY; END_SCHEMA;`);
  expect(schemas.IntPoint.safeParse({ IntegerX: 1 }).success).toBe(true);
  expect(schemas.IntPoint.safeParse({ IntegerX: 0 }).success).toBe(false);
  expect(schemas.IntPoint.safeParse({ X: 1 }).success).toBe(false);
});

it('retains one authoring slot through successive renames (#11646)', () => {
  const { schemas } = generated(`SCHEMA S; ENTITY A; X : INTEGER; WHERE Valid : X > 0; END_ENTITY;
ENTITY B SUBTYPE OF (A); SELF\\A.X RENAMED Y : INTEGER; WHERE ValidY : Y > 0; END_ENTITY;
ENTITY C SUBTYPE OF (B); SELF\\B.Y RENAMED Zed : INTEGER; END_ENTITY; END_SCHEMA;`);
  for (const [entity, name] of [['A', 'X'], ['B', 'Y'], ['C', 'Zed']]) {
    for (const key of ['X', 'Y', 'Zed']) expect(schemas[entity].safeParse({ [key]: 1 }).success).toBe(key === name);
    expect(schemas[entity].safeParse({ [name]: 0 }).success).toBe(false);
  }
});

it('compares SELECT tags and values consistently for SET uniqueness (#11647)', async () => {
  const { schema, schemas } = generated(`SCHEMA S; TYPE A = INTEGER; END_TYPE; TYPE B = INTEGER; END_TYPE;
TYPE Choice = SELECT (A,B); END_TYPE; ENTITY Sample; Members : SET OF Choice; END_ENTITY; END_SCHEMA;`);
  for (const [tag, value, valid] of [['B', 1, true], ['A', 1, false], ['A', 2, true]] as const) {
    const members = [{ typed: { type: 'A', value: 1 } }, { typed: { type: tag, value } }];
    expect(schemas.Sample.safeParse({ Members: members }).success).toBe(valid);
    const report = await validateStepText(`DATA;#1=SAMPLE((A(1),${tag}(${value})));ENDSEC;`, { schema, categories: ['schema'] });
    expect(report.valid).toBe(valid);
  }
});

it('executes a supported constructor attribute beside a failed unrelated DERIVE (#11646)', async () => {
  const { schema, coverage } = generated(`SCHEMA S; ENTITY Bad; DERIVE Flag : LOGICAL := Mystery(1); END_ENTITY;
ENTITY Good; Flag : LOGICAL; END_ENTITY; ENTITY Probe; WHERE Pass : Good(TRUE).Flag;
Fail : Good(FALSE).Flag; Unsupported : Bad().Flag; END_ENTITY; END_SCHEMA;`);
  expect(coverage.unsupported.map(row => [row.owner, row.label])).toEqual([['Bad','Flag'], ['Probe','Unsupported']]);
  const report = await validateStepText('DATA;#1=PROBE();ENDSEC;', {schema, categories: ['entity_rule']});
  expect(report.findings.map(f => f.rule)).toEqual(['Probe.Fail']);
});

it('preserves typed SELECT identity in compiled SET assignment (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; TYPE A = INTEGER; END_TYPE; TYPE B = INTEGER; END_TYPE;
TYPE Choice = SELECT (A,B); END_TYPE; ENTITY Sample; Items : LIST OF Choice;
WHERE W : CountItems(Items) = 2; END_ENTITY;
FUNCTION CountItems(X : SET OF Choice) : INTEGER; RETURN(SIZEOF(X)); END_FUNCTION; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=SAMPLE((A(1),B(1)));#2=SAMPLE((A(1),A(1)));#3=SAMPLE((A(1),A(2)));ENDSEC;', {schema, categories:['entity_rule']});
  expect(report.findings.map(f => [f.instance,f.rule])).toEqual([[2,'Sample.W']]);
});

it('agrees on SET size, membership and equality for typed and untagged values (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; TYPE A = INTEGER; END_TYPE; TYPE B = INTEGER; END_TYPE;
ENTITY Probe; WHERE
Mixed : (A(1) = 1) AND (1 IN [A(1)]) AND (A(1) IN [1]) AND (CountMembers([A(1),1]) = 1) AND (CountMembers([1,A(1)]) = 1);
DistinctTags : (A(1) <> B(1)) AND NOT (B(1) IN [A(1)]) AND (CountMembers([A(1),B(1)]) = 2);
DistinctValues : CountMembers([A(1),2]) = 2;
END_ENTITY; FUNCTION CountMembers(X : SET OF GENERIC) : INTEGER; RETURN(SIZEOF(X)); END_FUNCTION; END_SCHEMA;`);
  const report = await validateStepText('DATA;#7=PROBE();ENDSEC;', {schema, categories:['entity_rule']});
  expect(report.notEvaluated).toEqual([]);
  expect(report.stats.entityRuleEvaluations).toBe(3);
  expect(report.findings).toEqual([]);
});

it('retains REAL arithmetic results in generated TYPEOF rules (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY E; N : REAL; I : INTEGER; WHERE
Quotient : 'REAL' IN TYPEOF(N / 1.); IntegerQuotient : 'REAL' IN TYPEOF(I / I);
Sum : 'REAL' IN TYPEOF(I + N); Product : 'REAL' IN TYPEOF(N * I);
Difference : 'REAL' IN TYPEOF(N - N); Negative : 'REAL' IN TYPEOF(-N);
Whole : 'INTEGER' IN TYPEOF(I + I); Truncated : 'INTEGER' IN TYPEOF(N DIV I);
Opposite : 'INTEGER' IN TYPEOF(N / 1.); END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=E(5.,1);ENDSEC;', { schema, categories: ['entity_rule'] });
  expect(report.stats.entityRuleEvaluations).toBe(9);
  expect(report.findings.map(f => f.rule)).toEqual(['E.Opposite']);
});

it('compares SET OF BINARY members by bit value through STEP validation (#11647)', async () => {
  const { schema } = generated('SCHEMA S; ENTITY E; Items : SET OF BINARY; END_ENTITY; END_SCHEMA;');
  const report = await validateStepText('DATA;#1=E(("0FF","0ff"));#2=E(("0FF","0fe"));#3=E(("01F","31f"));ENDSEC;', { schema, categories: ['schema'] });
  expect(report.findings.map(f => [f.instance, f.rule])).toEqual([[1, 'invalid-type']]);
});

it('applies BLENGTH in generated BINARY refinements (#11647)', () => {
  const { schemas } = generated('SCHEMA S; TYPE Bits = BINARY; WHERE Eight : BLENGTH(SELF) = 8; END_TYPE; END_SCHEMA;');
  expect(schemas.Bits.safeParse('0FF').success).toBe(true);
  expect(schemas.Bits.safeParse('0F').success).toBe(false);
});

it('indexes nested ARRAY attributes with both declared bounds (#11647)', async () => {
  const { schema } = generated(`SCHEMA S; ENTITY E; Items : ARRAY [2:3] OF ARRAY [0:1] OF INTEGER;
WHERE First : Items[2][0] = 10; Last : Items[3][1] = 40; END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=E(((10,20),(30,40)));#2=E(((99,20),(30,40)));#3=E(((10,20),(30,99)));ENDSEC;', { schema });
  expect(report.findings.filter(f => f.rule === 'E.First' || f.rule === 'E.Last').map(f => [f.instance, f.rule])).toEqual([[2, 'E.First'], [3, 'E.Last']]);
});

it('uses the declaring parent slot for UNIQUE, INVERSE and USEDIN (#11647)', async () => {
  const { schema } = generated(`SCHEMA S;
ENTITY Item;
INVERSE Links : SET [0:?] OF A FOR X;
WHERE ViaInverse : SIZEOF(Links) = 1; ViaRole : SIZEOF(USEDIN(SELF,'S.A.X')) = 1;
END_ENTITY;
ENTITY A; X : Item; UNIQUE UA : X; END_ENTITY;
ENTITY B; X : Item; UNIQUE UB : X; END_ENTITY;
ENTITY C SUBTYPE OF (A,B); END_ENTITY; END_SCHEMA;`);
  const report = await validateStepText('DATA;#1=ITEM();#2=ITEM();#3=ITEM();#4=C(#1,#3);#5=C(#2,#3);#6=C(#2,#7);#7=ITEM();ENDSEC;', { schema });
  expect(report.findings.filter(f => f.category === 'unique_rule').map(f => [f.rule, f.instance])).toEqual([['A.UA', 6], ['B.UB', 5]]);
  for (const rule of ['Item.ViaInverse', 'Item.ViaRole']) {
    expect(report.findings.filter(f => f.rule === rule).map(f => f.instance)).toEqual([2, 3, 7]);
  }
});

it('selects evaluation errors across type, entity and global rules (#11647)', async () => {
  const { schema } = generated(`SCHEMA S;
FUNCTION Probe(N : INTEGER) : BOOLEAN;
LOCAL Missing : INTEGER; END_LOCAL;
IF N = 1 THEN CASE Missing OF 1 : RETURN(TRUE); END_CASE; END_IF;
RETURN(N <> 2); END_FUNCTION;
TYPE Num = INTEGER; WHERE T : Probe(SELF); END_TYPE;
ENTITY E; N : Num; WHERE W : Probe(N); END_ENTITY;
RULE Population FOR (E); WHERE G : Probe(SIZEOF(E)); END_RULE;
END_SCHEMA;`);
  const run = (records: string) => validateStepText('DATA;' + records + 'ENDSEC;', { schema, categories: ['evaluation_error'] });
  const errors = await run('#1=E(1);');
  expect(errors.valid).toBe(false);
  expect(errors.findings.map(f => [f.category, f.rule])).toEqual([
    ['evaluation_error', 'Num.T'], ['evaluation_error', 'E.W'], ['evaluation_error', 'Population'],
  ]);
  const ordinary = '#1=E(2);#2=E(2);';
  const all = await validateStepText('DATA;' + ordinary + 'ENDSEC;', { schema, categories: ['simpletype_rule', 'entity_rule', 'global_rule'] });
  expect(new Set(all.findings.map(f => f.rule))).toEqual(new Set(['Num.T', 'E.W', 'Population.G']));
  for (const records of [ordinary, '#1=E(0);#2=E(0);#3=E(0);']) {
    expect(await run(records)).toMatchObject({ valid: true, findings: [] });
  }
});
