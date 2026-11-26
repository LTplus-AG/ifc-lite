/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clause forms the rule parser models (#11110), one representative of
 * each, plus a cross-check that it reads the same type surface as the regex
 * parser the existing generators use on every bundled schema.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExpressRules } from '../src/express/declaration-parser.js';
import { ExpressSyntaxError } from '../src/express/lexer.js';
import { parseExpressSchema } from '../src/express-parser.js';

const SCHEMA = `SCHEMA CLAUSES;
(* a (* nested *) remark *)
TYPE PositiveLength = REAL;
WHERE
  WR1 : SELF > 0.;
END_TYPE;

TYPE Kind = ENUMERATION OF (SOLID, USERDEFINED, NOTDEFINED); END_TYPE;
TYPE Measure = SELECT (PositiveLength, Kind); END_TYPE;
TYPE Wide = EXTENSIBLE GENERIC_ENTITY SELECT; END_TYPE;
TYPE Narrow = SELECT BASED_ON Wide WITH (Shape); END_TYPE;
TYPE Code = STRING(22) FIXED; END_TYPE;

ENTITY Shape
  ABSTRACT SUPERTYPE OF (ONEOF (Box, Ball))
  SUBTYPE OF (Thing);
  Name : OPTIONAL STRING;
  Points : LIST [2:?] OF UNIQUE ARRAY [1:3] OF REAL;
  Width, Depth : PositiveLength;
DERIVE
  Area : REAL := Width * Depth; -- tail remark
  SELF\\Thing.Dim : INTEGER := HIINDEX(Points[1]);
INVERSE
  UsedBy : SET [0:1] OF Holder FOR Held;
  Owners : BAG OF Holder FOR Thing.Owned;
UNIQUE
  UR1 : Name;
  UR2 : SELF\\Thing.Tag, Width;
WHERE
  HasName : EXISTS(Name) AND (Name <> 'it''s');
  SIZEOF(QUERY(p <* Points | p[1] < 0)) = 0;
END_ENTITY;

FUNCTION Clamp (Lo, Hi : REAL; V : REAL) : REAL;
LOCAL
  R : REAL := V;
  I : INTEGER;
END_LOCAL;
  IF R < Lo THEN R := Lo; ELSE IF R > Hi THEN R := Hi; END_IF; END_IF;
  CASE I OF
    1, 2 : R := R + 1;
    OTHERWISE : ;
  END_CASE;
  REPEAT I := 1 TO 3 BY 1;
    IF I = 2 THEN ESCAPE; END_IF;
    SKIP;
  END_REPEAT;
  REPEAT WHILE R > Hi; R := R - 1; END_REPEAT;
  ALIAS X FOR R; X := X * 1; END_ALIAS;
  RETURN (R);
END_FUNCTION;

RULE OneShape FOR (Shape);
LOCAL
  N : INTEGER := 0;
END_LOCAL;
  N := SIZEOF(Shape);
WHERE
  WR1 : N <= 1;
END_RULE;

PROCEDURE Ignored; END_PROCEDURE;
CONSTANT
  Eps : REAL := 1.E-5;
END_CONSTANT;
END_SCHEMA;`;

describe('EXPRESS rule parser: clause forms (#11110)', () => {
  const s = parseExpressRules(SCHEMA);
  const shape = s.entities[0];

  it('parses TYPE specifications and their WHERE rules', () => {
    expect(s.name).toBe('CLAUSES');
    expect(s.types.map((t) => [t.name, t.spec.k])).toEqual([
      ['PositiveLength', 'simple'], ['Kind', 'enumeration'], ['Measure', 'select'],
      ['Wide', 'select'], ['Narrow', 'select'], ['Code', 'simple'],
    ]);
    expect(s.types[0].where).toEqual([{
      label: 'WR1', source: 'SELF > 0.',
      expr: { k: 'binary', op: '>', left: { k: 'self' }, right: { k: 'num', value: 0, int: false } },
    }]);
    expect(s.types[1].spec).toEqual({ k: 'enumeration', items: ['SOLID', 'USERDEFINED', 'NOTDEFINED'], extensible: false });
    expect(s.types[3].spec).toEqual({ k: 'select', items: [], extensible: true });
    expect(s.types[4].spec).toEqual({ k: 'select', items: ['Shape'], basedOn: 'Wide', extensible: false });
    expect(s.types[5].spec).toMatchObject({ k: 'simple', name: 'STRING', width: { k: 'num', value: 22 }, fixed: true });
  });

  it('parses the ENTITY header and explicit attributes', () => {
    expect(shape).toMatchObject({ name: 'Shape', abstract: true, supertypes: ['Thing'] });
    expect(shape.explicit.map((a) => [a.name, a.optional])).toEqual([
      ['Name', true], ['Points', false], ['Width', false], ['Depth', false],
    ]);
    expect(shape.explicit[1].type).toMatchObject({
      k: 'aggregate', kind: 'LIST', unique: true, low: { k: 'num', value: 2 }, high: { k: 'indeterminate' },
      of: { k: 'aggregate', kind: 'ARRAY', of: { k: 'simple', name: 'REAL' } },
    });
  });

  it('parses DERIVE, including a redeclared supertype attribute', () => {
    expect(shape.derived.map((d) => [d.name, d.source, d.redeclares])).toEqual([
      ['Area', 'Width * Depth', undefined],
      ['Dim', 'HIINDEX(Points[1])', { entity: 'Thing', attribute: 'Dim' }],
    ]);
  });

  it('parses INVERSE with and without bounds, and a qualified FOR attribute', () => {
    expect(shape.inverse).toEqual([
      { name: 'UsedBy', aggregate: 'SET', low: { k: 'num', value: 0, int: true }, high: { k: 'num', value: 1, int: true }, entity: 'Holder', forAttribute: 'Held' },
      { name: 'Owners', aggregate: 'BAG', entity: 'Holder', forAttribute: 'Owned' },
    ]);
  });

  it('parses UNIQUE, including a group-qualified attribute', () => {
    expect(shape.unique).toEqual([
      { label: 'UR1', attributes: [{ name: 'Name' }] },
      { label: 'UR2', attributes: [{ entity: 'Thing', name: 'Tag' }, { name: 'Width' }] },
    ]);
  });

  it('parses entity WHERE rules, labelling an unnamed one WR<n> and unescaping strings', () => {
    expect(shape.where.map((w) => w.label)).toEqual(['HasName', 'WR1']);
    expect(shape.where[0].expr).toMatchObject({ k: 'binary', op: 'AND', right: { k: 'binary', op: '<>', right: { k: 'str', value: "it's" } } });
    expect(shape.where[1].expr).toMatchObject({ k: 'binary', op: '=', left: { k: 'call', name: 'SIZEOF', args: [{ k: 'query', variable: 'p' }] } });
  });

  it('parses FUNCTION parameters, LOCAL and every statement form', () => {
    const [fn] = s.functions;
    expect(fn.params.map((p) => p.name)).toEqual(['Lo', 'Hi', 'V']);
    expect(fn.returns).toEqual({ k: 'simple', name: 'REAL' });
    expect(fn.locals).toEqual([
      { name: 'R', type: { k: 'simple', name: 'REAL' }, init: { k: 'id', name: 'V' } },
      { name: 'I', type: { k: 'simple', name: 'INTEGER' } },
    ]);
    expect(fn.body.map((st) => st.k)).toEqual(['if', 'case', 'repeat', 'repeat', 'alias', 'return']);
    const [ifStmt, caseStmt, forLoop, whileLoop] = fn.body;
    expect(ifStmt).toMatchObject({ k: 'if', elseBody: [{ k: 'if' }] });
    expect(caseStmt).toMatchObject({ k: 'case', branches: [{ labels: [{ value: 1 }, { value: 2 }] }], otherwise: { k: 'null' } });
    expect(forLoop).toMatchObject({ k: 'repeat', variable: 'I', by: { value: 1 }, body: [{ k: 'if', thenBody: [{ k: 'escape' }] }, { k: 'skip' }] });
    expect(whileLoop).toMatchObject({ k: 'repeat', whileCond: { k: 'binary', op: '>' } });
  });

  it('parses a global RULE with its LOCAL, body and WHERE', () => {
    expect(s.rules).toEqual([expect.objectContaining({
      name: 'OneShape', appliesTo: ['Shape'],
      body: [{ k: 'assign', target: { k: 'id', name: 'N' }, value: { k: 'call', name: 'SIZEOF', args: [{ k: 'id', name: 'Shape' }] } }],
      where: [expect.objectContaining({ label: 'WR1', source: 'N <= 1' })],
    })]);
  });

  it('records PROCEDURE and CONSTANT as skipped rather than dropping them', () => {
    expect(s.skipped).toEqual([{ kind: 'PROCEDURE', name: 'Ignored' }, { kind: 'CONSTANT', name: '' }]);
  });

  it('reports a syntax error with its line', () => {
    const broken = 'SCHEMA X;\nENTITY A;\n  B : ;\nEND_ENTITY;\nEND_SCHEMA;';
    expect(() => parseExpressRules(broken)).toThrow(ExpressSyntaxError);
    expect(() => parseExpressRules(broken)).toThrow("expected type at line 3, found ';'");
    expect(() => parseExpressRules('SCHEMA X; (* open')).toThrow('unterminated (* remark');
  });
});

describe('EXPRESS rule parser: malformed and edge input (#11110 review)', () => {
  const typeWhere = (where: string) => `SCHEMA X; TYPE T = REAL; WHERE ${where} END_TYPE; END_SCHEMA;`;
  const fnBody = (body: string) => `SCHEMA X; FUNCTION F : REAL; ${body} END_FUNCTION; END_SCHEMA;`;

  it('numbers an unlabelled WHERE rule past the labels the clause already uses', () => {
    const [t] = parseExpressRules(typeWhere('SELF < 9; WR1 : SELF > 0; SELF < 1;')).types;
    expect(t.where.map((w) => w.label)).toEqual(['WR2', 'WR1', 'WR3']);
  });

  it('rejects a WHERE rule with a colon but no label', () => {
    expect(() => parseExpressRules(typeWhere(': SELF > 0;'))).toThrow('expected expression');
  });

  it('rejects an exponent with no digits instead of producing NaN', () => {
    expect(() => parseExpressRules(typeWhere('WR1 : SELF > 1.5E+;'))).toThrow('expected exponent digits');
    expect(parseExpressRules(typeWhere('WR1 : SELF > 1.5E+2;')).types[0].where[0].expr)
      .toMatchObject({ right: { k: 'num', value: 150, int: false } });
  });

  it('ignores a leading byte-order mark', () => {
    expect(parseExpressRules('﻿SCHEMA X; END_SCHEMA;').name).toBe('X');
  });

  it('allows one OTHERWISE, as the last CASE branch', () => {
    const twice = 'CASE 1 OF OTHERWISE : RETURN (1.); OTHERWISE : RETURN (2.); END_CASE; RETURN (0.);';
    expect(() => parseExpressRules(fnBody(twice))).toThrow("expected END_CASE at line 1, found 'OTHERWISE'");
    const early = 'CASE 1 OF OTHERWISE : RETURN (1.); 1 : RETURN (2.); END_CASE; RETURN (0.);';
    expect(() => parseExpressRules(fnBody(early))).toThrow('expected END_CASE');
  });

  it('points a bad statement or declaration error at the offending token', () => {
    expect(() => parseExpressRules(fnBody('a.b; RETURN (0.);'))).toThrow("expected assignment or procedure call at line 1, found ';'");
    expect(() => parseExpressRules('SCHEMA X; FOO BAR; END_SCHEMA;')).toThrow("expected a declaration at schema level at line 1, found 'FOO'");
  });

  it('requires END_SCHEMA and nothing after it', () => {
    expect(() => parseExpressRules('SCHEMA X; TYPE T = REAL; END_TYPE;')).toThrow('expected END_SCHEMA');
    expect(() => parseExpressRules('SCHEMA X; END_SCHEMA; garbage;')).toThrow('expected end of input after END_SCHEMA');
    expect(() => parseExpressRules('SCHEMA X; END_SCHEMA')).toThrow("expected ';'");
  });
});

describe('EXPRESS rule parser agrees with the regex parser on every bundled schema (#11110)', () => {
  const schemaSource = (file: string) => readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');

  it.each(['IFC2X3_TC1.exp', 'IFC4_ADD2_TC1.exp', 'IFC4X1.exp', 'IFC4X2.exp', 'IFC4X3.exp'])('%s', (file) => {
    const source = schemaSource(file);
    const regex = parseExpressSchema(source);
    const rules = parseExpressRules(source);

    // The surface the existing generators emit from: entity names, ABSTRACT,
    // the supertype, and each explicit attribute with its OPTIONAL flag.
    // Redeclared attributes (SELF\X.Y) are skipped by the regex parser.
    const surface = (name: string, abstract: boolean, supertype: string | undefined, attrs: string[]) =>
      `${name}${abstract ? ' ABSTRACT' : ''} < ${supertype ?? '-'} (${attrs.join(', ')})`;
    expect(rules.entities.map((e) => surface(
      e.name, e.abstract, e.supertypes[0],
      e.explicit.filter((a) => !a.redeclares).map((a) => `${a.name}${a.optional ? '?' : ''}`),
    ))).toEqual(regex.entities.map((e) => surface(
      e.name, e.isAbstract, e.supertype, e.attributes.map((a) => `${a.name}${a.optional ? '?' : ''}`),
    )));
    expect(rules.entities.every((e) => e.supertypes.length <= 1)).toBe(true);
    expect(new Set(rules.types.map((t) => t.name))).toEqual(
      new Set([...regex.types, ...regex.enums, ...regex.selects].map((t) => t.name)),
    );
  });

  // WHERE rules are not compared: the regex parser stops IfcSweptSurface's
  // at the DERIVE inside 'IFC2X3.IFCDERIVEDPROFILEDEF' and keeps one of two.
  // Nothing reads its whereRules; this parser keeps both.
  it('keeps a WHERE rule whose string literal contains a section keyword', () => {
    const rules = parseExpressRules(schemaSource('IFC2X3_TC1.exp')).entities.find((e) => e.name === 'IfcSweptSurface');
    expect(rules?.where.map((w) => w.label)).toEqual(['WR1', 'WR2']);
  });
});
