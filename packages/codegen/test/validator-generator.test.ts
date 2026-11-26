/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generateValidators } from '../src/index.js';

const schemaSource = (file: string) => readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');
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

  it('compiles SKIP to a break out of a labelled body, so the UNTIL test still runs', () => {
    const fn = `FUNCTION F (X : MiniLabel) : INTEGER; LOCAL N : INTEGER := 0; END_LOCAL;
REPEAT UNTIL N > 3; N := N + 1; IF N = 2 THEN SKIP; END_IF; END_REPEAT; RETURN (N); END_FUNCTION;`;
    const rules = generateValidators(mini('WR1 : TRUE', fn)).files['rules.ts'];
    const loop = rules.slice(rules.indexOf('for (;;)'), rules.indexOf('return v_n'));
    expect(loop).toMatch(/(body\d+): \{[\s\S]*break \1;[\s\S]*\}\n\s*if \(r\.isTrue\(r\.gt\(v_n, 3\)\)\) break;/);
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
    expect(decl('Fixed')).not.toContain('localRuleRefinement');
    expect(zod).toMatch(/export const Req = z\.strictObject\(\{\n  Tag: z\.number\(\),\n\}\)/);
  });

  it('rejects a qualified enumeration item the enumeration does not declare', () => {
    const { coverage } = generateValidators(mini('WR1 : Kind <> MiniEnum.MISSING'));
    expect(coverage.unsupported[0].reason).toBe('MiniEnum has no item MISSING');
  });
});
