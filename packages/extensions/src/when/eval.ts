/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `when` clause evaluator.
 *
 * Evaluates a parsed expression against a typed `WhenContext` object. The
 * v1 context vocabulary is a small allow-list; unknown identifiers
 * evaluate to `undefined` and any comparison or coercion involving them
 * returns `false`.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §5.1.
 */

import type {
  WhenCompareOp,
  WhenContext,
  WhenExpression,
  WhenValue,
} from '../types.js';

/**
 * v1 allow-list of context keys. Unknown keys evaluate to undefined and
 * any boolean evaluation involving them is false.
 */
export const WHEN_CONTEXT_KEYS = [
  'model.loaded',
  'model.schema',
  'model.count',
  'selection.count',
  'selection.type',
  'viewer.open',
  'desktop',
  'embed',
] as const;

export type WhenContextKey = (typeof WHEN_CONTEXT_KEYS)[number];

const WHEN_CONTEXT_KEY_SET: ReadonlySet<string> = new Set(WHEN_CONTEXT_KEYS);

/** Default context — everything falsy. Useful for tests. */
export const EMPTY_WHEN_CONTEXT: WhenContext = Object.freeze({
  'model.loaded': false,
  'model.schema': undefined,
  'model.count': 0,
  'selection.count': 0,
  'selection.type': undefined,
  'viewer.open': false,
  desktop: false,
  embed: false,
});

export function evaluateWhen(expr: WhenExpression, ctx: WhenContext): boolean {
  return toBool(evaluate(expr, ctx));
}

function evaluate(expr: WhenExpression, ctx: WhenContext): WhenValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'identifier':
      // Enforce the v1 allow-list at lookup time. Unknown keys evaluate
      // to undefined regardless of what the context object contains, so
      // a typo or a host that accidentally exposes extra state cannot
      // leak through. Own-property check guards against prototype
      // pollution (e.g. "toString").
      if (!WHEN_CONTEXT_KEY_SET.has(expr.name)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(ctx, expr.name)) return undefined;
      return ctx[expr.name];
    case 'not':
      return !toBool(evaluate(expr.operand, ctx));
    case 'and': {
      const left = evaluate(expr.left, ctx);
      if (!toBool(left)) return false;
      return toBool(evaluate(expr.right, ctx));
    }
    case 'or': {
      const left = evaluate(expr.left, ctx);
      if (toBool(left)) return true;
      return toBool(evaluate(expr.right, ctx));
    }
    case 'compare': {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      return applyCompare(expr.op, left, right);
    }
    /* c8 ignore next */
    default:
      return false;
  }
}

function applyCompare(op: WhenCompareOp, left: WhenValue, right: WhenValue): boolean {
  // Equality is value-strict but tolerant of undefined.
  if (op === '==') return strictEq(left, right);
  if (op === '!=') return !strictEq(left, right);

  // Ordering requires both sides to be numbers or strings of the same kind.
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'boolean' || typeof right === 'boolean') return false;
  if (typeof left !== typeof right) return false;

  switch (op) {
    case '<':
      return (left as number | string) < (right as number | string);
    case '<=':
      return (left as number | string) <= (right as number | string);
    case '>':
      return (left as number | string) > (right as number | string);
    case '>=':
      return (left as number | string) >= (right as number | string);
  }
}

function strictEq(a: WhenValue, b: WhenValue): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a === b;
}

function toBool(v: WhenValue): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return false;
}
