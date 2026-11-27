/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which WHERE rules can be decided from an entity's own explicit attribute
 * values, without a model to dereference into. Those also run as zod
 * refinements, so an authoring tool rejects the value before it is written.
 */

import type { EntityDecl, Expr } from '../express/ast.js';
import type { SchemaIndex } from './schema-index.js';

import { BUILTINS } from './expr-translator.js';

export function isLocalRule(expr: Expr, entity: EntityDecl, index: SchemaIndex): boolean {
  const attributes = index.attributesOf(entity);
  const isExplicit = (name: string) => attributes.get(name.toUpperCase()) === 'explicit';
  const visit = (e: Expr, vars: Set<string>): boolean => {
    switch (e.k) {
      case 'num': case 'str': case 'logical': case 'indeterminate': case 'const':
        return true;
      case 'self':
        return false;
      case 'id': {
        const upper = e.name.toUpperCase();
        return vars.has(upper) || isExplicit(e.name) || (!attributes.has(upper) && index.enumItems.has(upper));
      }
      case 'attr':
        if (e.base.k === 'id' && !vars.has(e.base.name.toUpperCase()) && index.isEnumeration(e.base.name)) return true;
        return (e.base.k === 'self' || (e.base.k === 'group' && e.base.base.k === 'self')) && isExplicit(e.name);
      case 'group':
        return false;
      case 'index':
        return visit(e.base, vars) && visit(e.index, vars) && (!e.upper || visit(e.upper, vars));
      case 'call':
        return Object.hasOwn(BUILTINS, e.name.toUpperCase()) && !BUILTINS[e.name.toUpperCase()].model && e.args.every((a) => visit(a, vars));
      case 'unary':
        return visit(e.operand, vars);
      case 'binary':
        return e.op !== '||' && visit(e.left, vars) && visit(e.right, vars);
      case 'aggregate':
        return e.items.every((i) => visit(i.value, vars) && (!i.repeat || visit(i.repeat, vars)));
      case 'query':
        return visit(e.source, vars) && visit(e.predicate, new Set([...vars, e.variable.toUpperCase()]));
      case 'interval':
        return visit(e.low, vars) && visit(e.item, vars) && visit(e.high, vars);
    }
  };
  return visit(expr, new Set());
}
