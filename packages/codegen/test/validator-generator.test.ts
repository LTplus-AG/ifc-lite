/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generateValidators } from '../src/index.js';

const schemaSource = (file: string) => readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');

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
    const { files, coverage } = generateValidators(schemaSource(file));
    for (const [scope, c] of Object.entries(coverage.counts)) expect(c.compiled, scope).toBe(c.total);
    expect(coverage.unsupported).toEqual([]);
    expect([coverage.counts.entity.total, coverage.counts.type.total, coverage.counts.global.total, coverage.counts.function.total])
      .toEqual([entity, type, global, fns]);
    // TYPEOF literals use the qualifier the rules spell, not the file's schema name.
    expect(files['schema.ts']).toContain(`"typePrefix": "${typePrefix}"`);
  });

  it('emits modules that parse as TypeScript', () => {
    const { files } = generateValidators(schemaSource('IFC4X3.exp'));
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

  it('rejects a qualified enumeration item the enumeration does not declare', () => {
    const { coverage } = generateValidators(mini('WR1 : Kind <> MiniEnum.MISSING'));
    expect(coverage.unsupported[0].reason).toBe('MiniEnum has no item MISSING');
  });
});
