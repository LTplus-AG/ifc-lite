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
