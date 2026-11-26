/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { schemaSource } from './schema-fixture.js';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generateValidators } from '../src/index.js';

const generated = new Map<string, ReturnType<typeof generateValidators>>();
const generate = (file: string) => {
  if (!generated.has(file)) generated.set(file, generateValidators(schemaSource(file)));
  return generated.get(file)!;
};

const mini = (where: string, extra = '') => `SCHEMA MINI;
TYPE MiniLabel = STRING; END_TYPE;
TYPE MiniEnum = ENUMERATION OF (A, USERDEFINED); END_TYPE;
ENTITY MiniThing;
  Name : OPTIONAL MiniLabel;
  Kind : MiniEnum;
WHERE
  ${where};
END_ENTITY;
${extra}
END_SCHEMA;`;

function loadRules(source: string, runtime: Record<string, unknown>, entity = 'MiniThing'): { label: string; check: (self: object, model: object) => boolean }[] {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = { RULES: { entity: { [entity]: [] } } };
  runInNewContext(outputText, { exports, require: () => ({ EnumValue: class {}, ...runtime }) });
  return exports.RULES.entity[entity];
}

const setRuntime = {
  typeOf: (_model: unknown, names: string[]) => names,
  aggregate: (items: string[][]) => items.flat(),
  mul: (left: string[], right: string[]) => left.filter(name => right.includes(name)),
  sizeof: (items: unknown[]) => items.length,
  eq: (left: number, right: number) => left === right,
  ge: (left: number, right: number) => left >= right,
  attr: (entity: Record<string, unknown>, key: string) => entity[key],
  query: (items: string[][], matches: (names: string[]) => boolean) => items.filter(matches),
};

describe('generateValidators', () => {
  // Totals cross-checked against IfcOpenShell's compiled rule modules (#11559): every
  // entity WHERE, type WHERE and global RULE label it runs is one these schemas compile.
  it.each([
    ['IFC2X3_TC1.exp', 'IFC2X3', 339, 24, 2, 38],
    ['IFC4_ADD2_TC1.exp', 'IFC4', 652, 25, 2, 47],
    ['IFC4X3.exp', 'IFC4X3_DEV_923B0514', 752, 25, 2, 48],
  ])('compiles every rule, DERIVE, FUNCTION and global RULE of %s', (file, typePrefix, entity, type, global, fns) => {
    const { files, coverage } = generate(file);
    for (const [scope, c] of Object.entries(coverage.counts)) expect(c.compiled, scope).toBe(c.total);
    expect(coverage.unsupported).toEqual([]);
    expect([coverage.counts.entity.total, coverage.counts.type.total, coverage.counts.global.total, coverage.counts.function.total])
      .toEqual([entity, type, global, fns]);
    // TYPEOF literals use the qualifier the rules spell, not the file's schema name.
    expect(files['schema.ts']).toContain(`"typePrefix": "${typePrefix}"`);
  });

  it('emits modules that parse as TypeScript', () => {
    const { files } = generate('IFC4X3.exp');
    for (const [name, text] of Object.entries(files)) {
      if (!name.endsWith('.ts')) continue;
      const parsed = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
      expect(parsed.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), name).toEqual([]);
    }
  });

  it("compiles 'X' IN TYPEOF(e) to a membership test and AND/OR with a lazy right operand", () => {
    const { files } = generateValidators(mini("WR1 : ('MINI.MINITHING' IN TYPEOF(SELF)) AND EXISTS(Name)"));
    expect(files['rules.ts']).toContain('r.and(r.typeIs(m, self, "MINITHING"), () => r.exists(r.attr(self, "NAME")))');
  });

  it('reports a rule it cannot compile instead of dropping it', () => {
    const { coverage } = generateValidators(mini('WR1 : NOT EXISTS(Name) OR MysteryCheck(Name)'));
    expect(coverage.counts.entity).toEqual({ total: 1, compiled: 0 });
    expect(coverage.unsupported).toEqual([
      { scope: 'entity', owner: 'MiniThing', label: 'WR1', reason: 'call to unknown function MysteryCheck' },
    ]);
  });

  it('propagates an uncompilable FUNCTION to its callers and to the rules using them', () => {
    const fns = `FUNCTION Inner (X : MiniLabel) : LOGICAL; RETURN (VALUE_IN([X], X)); END_FUNCTION;
FUNCTION Outer (X : MiniLabel) : LOGICAL; RETURN (Inner(X)); END_FUNCTION;`;
    const { coverage } = generateValidators(mini('WR1 : Outer(Name)', fns));
    expect(coverage.unsupported.map((u) => [u.scope, u.owner])).toEqual([
      ['function', 'Inner'], ['function', 'Outer'], ['entity', 'MiniThing'],
    ]);
    expect(coverage.unsupported[1].reason).toBe('calls Inner, which did not compile: built-in VALUE_IN is not implemented');
  });

  it('marks a rule that reads a DERIVE which did not compile, but not one that only names it in a string', () => {
    const schema = `SCHEMA MINI;
ENTITY MiniThing;
  Width : REAL;
DERIVE
  Area : REAL := MysteryArea(Width);
WHERE
  WR1 : Area > 0.;
  WR2 : 'AREA' <> 'x';
END_ENTITY;
END_SCHEMA;`;
    const { coverage } = generateValidators(schema);
    expect(coverage.unsupported.map((u) => [u.scope, u.label, u.reason])).toEqual([
      ['derived', 'Area', 'call to unknown function MysteryArea'],
      ['entity', 'WR1', 'depends on derived attribute MiniThing.Area, which did not compile'],
    ]);
  });

  it('marks a FUNCTION that reads a DERIVE which did not compile, and the rules calling it', () => {
    const schema = `SCHEMA MINI;
ENTITY MiniThing;
  Width : REAL;
DERIVE
  Area : REAL := MysteryArea(Width);
WHERE
  WR1 : AreaOf(SELF) > 0.;
END_ENTITY;
FUNCTION AreaOf (T : MiniThing) : REAL; RETURN (T.Area); END_FUNCTION;
END_SCHEMA;`;
    const { coverage } = generateValidators(schema);
    expect(coverage.unsupported.map((u) => [u.scope, u.label])).toEqual([['function', 'AreaOf'], ['derived', 'Area'], ['entity', 'WR1']]);
    expect(coverage.counts.function).toEqual({ total: 1, compiled: 0 });
  });

  it.each([
    ['HIBOUND, which is not HIINDEX', 'RETURN (HIBOUND(X));', 'built-in HIBOUND is not implemented'],
    ['SKIP outside a REPEAT', 'SKIP; RETURN (N);', 'SKIP outside REPEAT'],
  ])('refuses %s instead of compiling it wrong', (_what, body, reason) => {
    const fn = `FUNCTION F (X : LIST [1:?] OF MiniLabel) : INTEGER; LOCAL N : INTEGER := 0; END_LOCAL; ${body} END_FUNCTION;`;
    expect(generateValidators(mini('WR1 : TRUE', fn)).coverage.unsupported).toEqual([{ scope: 'function', owner: 'F', label: 'F', reason }]);
  });

  it('preserves ordinary strings and qualifies type and role operands (#11559)', () => {
    const { files } = generateValidators(mini("WR1 : 'foo.MiniThing' <> 'bar.MiniThing'; WR2 : 'mini.minithing' IN TYPEOF(SELF); WR3 : EXISTS(USEDIN(SELF, 'mini.minithing.name'))"));
    const rules = loadRules(files['rules.ts'], {
      typeOf: () => ['MINI.MINITHING'],
      isIn: (value: string, names: string[]) => names.includes(value),
      ne: (a: string, b: string) => a !== b,
      typeIs: (_model: unknown, _entity: unknown, name: string) => name === 'MINITHING',
      usedIn: (_model: unknown, _entity: unknown, role: string) => role.endsWith('.MINITHING.NAME') ? role : undefined,
      exists: (value: unknown) => value !== undefined,
    });
    expect(rules.map(rule => rule.check({}, {}))).toEqual([true, true, true]);
  });

  it('matches type-name sets in either intersection order and preserves ordinary set literals (#11559)', () => {
    const { files } = generateValidators(mini("A : SIZEOF(TYPEOF(SELF) * ['mini.MiniThing']) = 1; B : SIZEOF(['mini.MiniThing'] * TYPEOF(SELF)) = 1; C : SIZEOF(['mini.MiniThing'] * ['MINI.MINITHING']) = 0; D : SIZEOF(['other.MiniThing'] * TYPEOF(SELF)) = 1; E : SIZEOF(TYPEOF(SELF) * ['other.MiniThing']) = 1"));
    const rules = loadRules(files['rules.ts'], setRuntime);
    expect(rules.map(rule => rule.check(['MINI.MINITHING'], {}))).toEqual([true, true, true, false, false]);
    expect(rules.map(rule => rule.check(['MINI.OTHER'], {}))).toEqual([false, false, true, false, false]);
  });

  it('executes IFC4X3 ApplicableOnlyToItems on matching and nonmatching assigned items', () => {
    const rules = loadRules(generate('IFC4X3.exp').files['rules.ts'], setRuntime, 'IfcPresentationLayerWithStyle');
    const rule = rules.find(rule => rule.label === 'ApplicableOnlyToItems')!;
    const valid = [['IFC4X3_DEV_923B0514.IFCMAPPEDITEM'], ['IFC4X3_DEV_923B0514.IFCGEOMETRICREPRESENTATIONITEM']];
    expect(rule.check({ ASSIGNEDITEMS: valid }, {})).toBe(true);
    expect(rule.check({ ASSIGNEDITEMS: [...valid, ['IFC4X3_DEV_923B0514.IFCWALL']] }, {})).toBe(false);
  });

  it('loads unrelated rules when ESCAPE is illegal and executes legal ESCAPE (#11559)', () => {
    const schema = mini('WR1 : Bad(Name); WR2 : Good(Name)',
      'FUNCTION Bad(X : MiniLabel) : LOGICAL; ESCAPE; END_FUNCTION; FUNCTION Good(X : MiniLabel) : LOGICAL; REPEAT WHILE TRUE; ESCAPE; END_REPEAT; RETURN (TRUE); END_FUNCTION;');
    const { files, coverage } = generateValidators(schema);
    expect(coverage.unsupported.map(u => u.reason)).toEqual(['ESCAPE outside REPEAT', 'calls Bad, which did not compile: ESCAPE outside REPEAT']);
    const rules = loadRules(files['rules.ts'], { isTrue: Boolean, attr: () => 'x' });
    expect(rules.find(rule => rule.label === 'WR2')?.check({}, {})).toBe(true);
  });

  it('compiles SKIP to a break out of a labelled body, so the UNTIL test still runs', () => {
    const fn = `FUNCTION F (X : MiniLabel) : INTEGER; LOCAL N : INTEGER := 0; END_LOCAL;
REPEAT UNTIL N > 3; N := N + 1; IF N = 2 THEN SKIP; END_IF; END_REPEAT; RETURN (N); END_FUNCTION;`;
    const rules = generateValidators(mini('WR1 : TRUE', fn)).files['rules.ts'];
    const loop = rules.slice(rules.indexOf('for (;;)'), rules.indexOf('return v_n'));
    expect(loop).toMatch(/(body_\d+): \{[\s\S]*break \1;[\s\S]*\}\n\s*if \(r\.isTrue\(r\.gt\(v_n, 3\)\)\) break;/);
    expect(loop).not.toContain('continue');
  });

  it("does not treat a three-part 'SCHEMA.ENTITY.ATTR' literal as a type in IN TYPEOF", () => {
    const { files } = generateValidators(mini("WR1 : 'MINI.MINITHING.NAME' IN TYPEOF(SELF)"));
    expect(files['rules.ts']).not.toContain('r.typeIs(');
  });

  it('runs a supertype rule as a zod refinement only where the attribute is still explicit', () => {
    const schema = `SCHEMA MINI;
ENTITY Base; Size : REAL; WHERE Positive : Size > 0.; END_ENTITY;
ENTITY Fixed SUBTYPE OF (Base); DERIVE SELF\\Base.Size : REAL := 1.; END_ENTITY;
ENTITY Free SUBTYPE OF (Base); END_ENTITY;
ENTITY Opt; Tag : OPTIONAL REAL; END_ENTITY;
ENTITY Req SUBTYPE OF (Opt); SELF\\Opt.Tag : REAL; END_ENTITY;
END_SCHEMA;`;
    const zod = generateValidators(schema).files['zod.ts'];
    const decl = (name: string) => zod.split('\nexport const ').find((d) => d.startsWith(`${name} =`)) ?? '';
    expect(decl('Free')).toContain('"Base.Positive"');
    expect(decl('Fixed')).toBeTruthy();
    expect(decl('Fixed')).not.toContain('localRuleRefinement');
    expect(zod).toMatch(/export const Req = z\.strictObject\(\{\n  Tag: z\.number\(\),\n\}\)/);
  });

  it('keeps supported sibling global labels and reports skipped declarations (#11559)', () => {
    const { coverage } = generateValidators(`SCHEMA S; ENTITY A; END_ENTITY;
RULE R FOR (A); WHERE Good : FALSE; Bad : Mystery(1); END_RULE;
SUBTYPE_CONSTRAINT C FOR A; END_SUBTYPE_CONSTRAINT; END_SCHEMA;`);
    expect(coverage.counts.global).toEqual({ total: 2, compiled: 1 });
    expect(coverage.unsupported.map(u => [u.scope, u.label])).toEqual([['schema', 'C'], ['global', 'Bad']]);
  });

  it('keeps independent same-named derived attributes compiled', () => {
    const { coverage } = generateValidators(`SCHEMA S;
ENTITY A; DERIVE Flag : LOGICAL := Mystery(1); WHERE W : Flag; END_ENTITY;
ENTITY B; DERIVE Flag : LOGICAL := TRUE; WHERE W : Flag; END_ENTITY; END_SCHEMA;`);
    expect(coverage.unsupported.map(u => [u.owner, u.label])).toEqual([['A', 'Flag'], ['A', 'W']]);
  });

  it('retains aggregate bounds, both parents, and extension members in generated metadata', () => {
    const { files } = generateValidators(`SCHEMA S; ENTITY A; END_ENTITY; ENTITY B; END_ENTITY;
ENTITY C SUBTYPE OF (A,B); END_ENTITY;
TYPE T = LIST [1+1:4] OF INTEGER; END_TYPE;
TYPE E = EXTENSIBLE ENUMERATION OF (OPEN); END_TYPE;
TYPE F = ENUMERATION BASED_ON E WITH (CLOSED); END_TYPE;
TYPE Sel = EXTENSIBLE SELECT (A); END_TYPE;
TYPE More = SELECT BASED_ON Sel WITH (B); END_TYPE; END_SCHEMA;`);
    const js = ts.transpileModule(files['schema.ts'], { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = { META: { entities: [], types: [] } };
    runInNewContext(js, { exports });
    expect(exports.META.entities).toContainEqual(expect.objectContaining({ name: 'C', supertypes: ['A', 'B'] }));
    expect(exports.META.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'T', underlying: expect.objectContaining({ low: 2, high: 4 }) }),
      expect.objectContaining({ name: 'F', items: ['OPEN', 'CLOSED'] }),
      expect.objectContaining({ name: 'More', items: ['A', 'B'] }),
    ]));
  });

  it('rejects a qualified enumeration item the enumeration does not declare', () => {
    const { coverage } = generateValidators(mini('WR1 : Kind <> MiniEnum.MISSING'));
    expect(coverage.unsupported[0].reason).toBe('MiniEnum has no item MISSING');
  });
});
