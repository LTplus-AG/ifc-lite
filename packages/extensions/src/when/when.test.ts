/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { evaluateWhen } from './eval.js';
import { parseWhen } from './parse.js';
import type { WhenContext } from '../types.js';

function parse(src: string) {
  const r = parseWhen(src);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

function evalCtx(src: string, ctx: WhenContext): boolean {
  return evaluateWhen(parse(src), ctx);
}

describe('parseWhen — happy', () => {
  it('parses single identifier', () => {
    expect(parse('model.loaded').kind).toBe('identifier');
  });

  it('parses true/false literals', () => {
    expect(parse('true').kind).toBe('literal');
  });

  it('parses string literal with single quotes', () => {
    const expr = parse("selection.type == 'IfcWall'");
    expect(expr.kind).toBe('compare');
  });

  it('parses double-quoted strings', () => {
    expect(parse('selection.type == "IfcWall"').kind).toBe('compare');
  });

  it('parses boolean &&', () => {
    expect(parse('model.loaded && selection.count > 0').kind).toBe('and');
  });

  it('parses boolean ||', () => {
    expect(parse('desktop || embed').kind).toBe('or');
  });

  it('parses negation', () => {
    expect(parse('!model.loaded').kind).toBe('not');
  });

  it('parses parentheses', () => {
    expect(parse('(model.loaded || desktop) && viewer.open').kind).toBe('and');
  });

  it('parses numeric comparison', () => {
    expect(parse('selection.count >= 1').kind).toBe('compare');
  });
});

describe('parseWhen — errors', () => {
  it('rejects empty string', () => {
    expect(parseWhen('').ok).toBe(false);
  });

  it('rejects unbalanced parens', () => {
    expect(parseWhen('(model.loaded').ok).toBe(false);
  });

  it('rejects trailing tokens', () => {
    expect(parseWhen('model.loaded foo').ok).toBe(false);
  });

  it('rejects bare !=', () => {
    // "!=" cannot start an expression
    expect(parseWhen('!= 0').ok).toBe(false);
  });
});

describe('evaluateWhen', () => {
  const CTX: WhenContext = {
    'model.loaded': true,
    'model.schema': 'IFC4',
    'model.count': 2,
    'selection.count': 3,
    'selection.type': 'IfcWall',
    'viewer.open': true,
    desktop: false,
    embed: false,
  };

  it('reads boolean identifier', () => {
    expect(evalCtx('model.loaded', CTX)).toBe(true);
  });

  it('handles negation', () => {
    expect(evalCtx('!desktop', CTX)).toBe(true);
  });

  it('&& short-circuits', () => {
    expect(evalCtx('desktop && model.loaded', CTX)).toBe(false);
  });

  it('|| short-circuits', () => {
    expect(evalCtx('model.loaded || never.exists', CTX)).toBe(true);
  });

  it('string equality', () => {
    expect(evalCtx("selection.type == 'IfcWall'", CTX)).toBe(true);
    expect(evalCtx("selection.type == 'IfcDoor'", CTX)).toBe(false);
  });

  it('numeric ordering', () => {
    expect(evalCtx('selection.count > 0', CTX)).toBe(true);
    expect(evalCtx('selection.count <= 2', CTX)).toBe(false);
  });

  it('undefined identifier is falsy', () => {
    expect(evalCtx('does.not.exist', CTX)).toBe(false);
  });

  it('mixed-type ordering returns false', () => {
    expect(evalCtx("selection.count > 'a'", CTX)).toBe(false);
  });

  it('equality on undefined', () => {
    expect(evalCtx('does.not.exist == "x"', CTX)).toBe(false);
    expect(evalCtx('does.not.exist != "x"', CTX)).toBe(true);
  });

  it('complex expression', () => {
    expect(
      evalCtx(
        "(model.loaded && selection.count > 0) && selection.type == 'IfcWall'",
        CTX,
      ),
    ).toBe(true);
  });

  it('escaped quote in string', () => {
    const r = parseWhen("selection.type == 'It\\'s'");
    expect(r.ok).toBe(true);
  });
});
