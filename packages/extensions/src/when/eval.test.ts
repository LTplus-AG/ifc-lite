/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `when` evaluator — the guards the existing `when.test.ts` does not pin.
 *
 * `when` clauses come out of an extension manifest, i.e. third-party
 * text, and decide whether a contribution is shown. The two lookup
 * guards in `evaluate()` — the v1 allow-list and the own-property check
 * — are the whole reason a host that accidentally puts extra state on
 * the context object cannot leak it to an extension, and neither was
 * exercised: deleting either left all 603 tests green. So did making
 * the empty string truthy and letting booleans through the ordering
 * comparisons.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_WHEN_CONTEXT, WHEN_CONTEXT_KEYS, evaluateWhen } from './eval.js';
import { parseWhen } from './parse.js';
import type { WhenContext } from '../types.js';

function parse(src: string) {
  const r = parseWhen(src);
  if (!r.ok) throw new Error(`fixture "${src}" does not parse: ${r.errors[0].message}`);
  return r.value;
}

function evalCtx(src: string, ctx: WhenContext): boolean {
  return evaluateWhen(parse(src), ctx);
}

describe('EMPTY_WHEN_CONTEXT', () => {
  it('covers exactly the v1 key vocabulary', () => {
    expect(Object.keys(EMPTY_WHEN_CONTEXT).sort()).toEqual([...WHEN_CONTEXT_KEYS].sort());
  });

  it('makes every key evaluate falsy', () => {
    for (const key of WHEN_CONTEXT_KEYS) {
      expect(evalCtx(key, EMPTY_WHEN_CONTEXT)).toBe(false);
    }
  });

  it('is frozen so a host cannot mutate the shared default', () => {
    expect(Object.isFrozen(EMPTY_WHEN_CONTEXT)).toBe(true);
  });
});

describe('identifier lookup — v1 allow-list', () => {
  // Without the allow-list gate, an identifier a *host* happens to put on
  // the context object becomes readable from third-party manifest text.
  it('ignores a context key outside the v1 vocabulary even when present', () => {
    const leaky = {
      ...EMPTY_WHEN_CONTEXT,
      'internal.licenseKey': true,
    } as unknown as WhenContext;

    expect(evalCtx('internal.licenseKey', leaky)).toBe(false);
  });

  it('still reads an allow-listed key from the same object', () => {
    const leaky = {
      ...EMPTY_WHEN_CONTEXT,
      'internal.licenseKey': true,
      'model.loaded': true,
    } as unknown as WhenContext;

    expect(evalCtx('model.loaded', leaky)).toBe(true);
  });

  it('treats an allow-listed key the context omits as undefined, not inherited', () => {
    const partial = { 'model.loaded': true } as unknown as WhenContext;
    expect(evalCtx('model.loaded', partial)).toBe(true);
    expect(evalCtx('viewer.open', partial)).toBe(false);
  });
});

describe('identifier lookup — own-property gate', () => {
  // `expr.name in ctx` would walk the prototype chain. None of the v1
  // key names collide with Object.prototype, so the gate only bites for
  // a context whose *prototype* carries an allow-listed key — exactly
  // what a `Object.create(defaults)` host would produce, and it must not
  // resolve.
  it('does not resolve an allow-listed key inherited from the prototype', () => {
    const proto = { 'model.loaded': true };
    const ctx = Object.create(proto) as WhenContext;

    expect('model.loaded' in (ctx as object)).toBe(true);
    expect(evalCtx('model.loaded', ctx)).toBe(false);
  });

  it('resolves the same key once it is an own property', () => {
    const proto = { 'model.loaded': true };
    const ctx = Object.create(proto) as WhenContext;
    (ctx as Record<string, unknown>)['model.loaded'] = true;

    expect(evalCtx('model.loaded', ctx)).toBe(true);
  });
});

describe('truthiness coercion', () => {
  it('treats the empty string as false and a non-empty string as true', () => {
    const empty = { ...EMPTY_WHEN_CONTEXT, 'selection.type': '' } as WhenContext;
    const set = { ...EMPTY_WHEN_CONTEXT, 'selection.type': 'IfcWall' } as WhenContext;

    expect(evalCtx('selection.type', empty)).toBe(false);
    expect(evalCtx('selection.type', set)).toBe(true);
  });

  it('treats 0 as false and a non-zero number as true', () => {
    expect(evalCtx('selection.count', { ...EMPTY_WHEN_CONTEXT, 'selection.count': 0 })).toBe(false);
    expect(evalCtx('selection.count', { ...EMPTY_WHEN_CONTEXT, 'selection.count': 3 })).toBe(true);
  });

  it('negation follows the same coercion', () => {
    const empty = { ...EMPTY_WHEN_CONTEXT, 'selection.type': '' } as WhenContext;
    expect(evalCtx('!selection.type', empty)).toBe(true);
  });
});

describe('ordering comparisons', () => {
  // JS would happily evaluate `true > false`. The evaluator refuses, so
  // a boolean context value can never satisfy an ordering clause.
  //
  // Mixed boolean/number is caught by the *later* `typeof left !== typeof
  // right` check as well, so it does not pin this guard. Two booleans do:
  // they pass the typeof check and only the explicit boolean rejection
  // stands between them and JS's numeric coercion.
  it('returns false when both sides of an ordering are booleans', () => {
    const ctx = { ...EMPTY_WHEN_CONTEXT, 'model.loaded': true, 'viewer.open': false } as WhenContext;

    expect(evalCtx('model.loaded > viewer.open', ctx)).toBe(false);
    expect(evalCtx('model.loaded >= viewer.open', ctx)).toBe(false);
    expect(evalCtx('viewer.open < model.loaded', ctx)).toBe(false);
    expect(evalCtx('viewer.open <= model.loaded', ctx)).toBe(false);
  });

  it('returns false when only one side of an ordering is a boolean', () => {
    const ctx = { ...EMPTY_WHEN_CONTEXT, 'model.loaded': true } as WhenContext;

    expect(evalCtx('model.loaded > 0', ctx)).toBe(false);
    expect(evalCtx('model.loaded <= 2', ctx)).toBe(false);
  });

  it('still orders numbers on both strict and inclusive operators', () => {
    const ctx = { ...EMPTY_WHEN_CONTEXT, 'selection.count': 2 } as WhenContext;

    expect(evalCtx('selection.count > 1', ctx)).toBe(true);
    expect(evalCtx('selection.count > 2', ctx)).toBe(false);
    expect(evalCtx('selection.count >= 2', ctx)).toBe(true);
    expect(evalCtx('selection.count < 3', ctx)).toBe(true);
    expect(evalCtx('selection.count <= 1', ctx)).toBe(false);
  });

  it('orders strings lexically', () => {
    const ctx = { ...EMPTY_WHEN_CONTEXT, 'selection.type': 'IfcWall' } as WhenContext;
    expect(evalCtx("selection.type > 'IfcSlab'", ctx)).toBe(true);
    expect(evalCtx("selection.type < 'IfcSlab'", ctx)).toBe(false);
  });

  it('returns false when an ordering side is undefined', () => {
    expect(evalCtx('selection.type > 1', EMPTY_WHEN_CONTEXT)).toBe(false);
  });
});

describe('equality', () => {
  it('is strict about type — booleans do not equal numbers', () => {
    const ctx = { ...EMPTY_WHEN_CONTEXT, 'model.loaded': true } as WhenContext;
    expect(evalCtx('model.loaded == 1', ctx)).toBe(false);
    expect(evalCtx('model.loaded != 1', ctx)).toBe(true);
    expect(evalCtx('model.loaded == true', ctx)).toBe(true);
  });

  it('treats two undefined sides as equal and one as unequal', () => {
    expect(evalCtx('selection.type == model.schema', EMPTY_WHEN_CONTEXT)).toBe(true);
    expect(evalCtx("selection.type == 'IfcWall'", EMPTY_WHEN_CONTEXT)).toBe(false);
    expect(evalCtx("selection.type != 'IfcWall'", EMPTY_WHEN_CONTEXT)).toBe(true);
  });
});
