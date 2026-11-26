/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExpressRules } from '../src/express/declaration-parser.js';
import { parseExpression } from '../src/express/expression-parser.js';
import { tokenize } from '../src/express/lexer.js';
import { TokenStream } from '../src/express/token-stream.js';

const schemaSource = (file: string) => readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');
const expr = (src: string) => parseExpression(new TokenStream(tokenize(src), src));

describe('EXPRESS expression parser', () => {
  it('binds NOT tighter than OR and AND tighter than OR (ISO 10303-11 12.1)', () => {
    expect(expr('NOT a OR b AND c')).toEqual({
      k: 'binary', op: 'OR',
      left: { k: 'unary', op: 'NOT', operand: { k: 'id', name: 'a' } },
      right: { k: 'binary', op: 'AND', left: { k: 'id', name: 'b' }, right: { k: 'id', name: 'c' } },
    });
  });

  it('parses QUERY, intervals, group qualifiers and indexing', () => {
    const q = expr("SIZEOF(QUERY(t <* SELF\\IfcFace.Bounds | 'IFC4.IFCEDGELOOP' IN TYPEOF(t.Bound))) = 1");
    expect(q.k).toBe('binary');
    expect(expr('{0 <= x < 3}')).toMatchObject({ k: 'interval', op1: '<=', op2: '<' });
    expect(expr('a[1].b')).toMatchObject({ k: 'attr', name: 'b', base: { k: 'index' } });
  });

  it('keeps INTEGER and REAL literals apart', () => {
    expect(expr('1')).toEqual({ k: 'num', value: 1, int: true });
    expect(expr('1.E-5')).toEqual({ k: 'num', value: 1e-5, int: false });
  });
});

describe('EXPRESS rule parser on the bundled schemas', () => {
  it.each([
    ['IFC4_ADD2_TC1.exp', 652, 25, 47, 2],
    ['IFC4X3.exp', 752, 25, 48, 2],
    ['IFC2X3_TC1.exp', 339, 24, 38, 2],
  ])('%s: entity WHERE, type WHERE, functions, global rules', (file, entityWhere, typeWhere, functions, rules) => {
    const s = parseExpressRules(schemaSource(file));
    expect(s.entities.reduce((n, e) => n + e.where.length, 0)).toBe(entityWhere);
    expect(s.types.reduce((n, t) => n + t.where.length, 0)).toBe(typeWhere);
    expect(s.functions).toHaveLength(functions);
    expect(s.rules).toHaveLength(rules);
    expect(s.skipped).toEqual([]);
  });
});
