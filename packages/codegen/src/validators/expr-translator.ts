/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EXPRESS expression -> TypeScript, against the `@ifc-lite/validate` runtime
 * (imported as `r`). Every operator goes through a runtime helper so
 * indeterminate values and three-valued logic follow ISO 10303-11.
 */

import type { BinaryOp, Expr } from '../express/ast.js';
import { functionIdentifier, Scope, TranslateContext, UnsupportedConstruct } from './translate-context.js';

const BUILTINS: Record<string, { fn: string; arity: number; model?: boolean }> = {
  SIZEOF: { fn: 'sizeof', arity: 1 },
  HIINDEX: { fn: 'hiindex', arity: 1 },
  LOINDEX: { fn: 'loindex', arity: 1 },
  HIBOUND: { fn: 'hiindex', arity: 1 },
  LOBOUND: { fn: 'loindex', arity: 1 },
  EXISTS: { fn: 'exists', arity: 1 },
  NVL: { fn: 'nvl', arity: 2 },
  TYPEOF: { fn: 'typeOf', arity: 1, model: true },
  USEDIN: { fn: 'usedIn', arity: 2, model: true },
  ABS: { fn: 'abs', arity: 1 },
  SQRT: { fn: 'sqrt', arity: 1 },
  SIN: { fn: 'sin', arity: 1 },
  COS: { fn: 'cos', arity: 1 },
  TAN: { fn: 'tan', arity: 1 },
  ASIN: { fn: 'asin', arity: 1 },
  ACOS: { fn: 'acos', arity: 1 },
  ATAN: { fn: 'atan', arity: 2 },
  EXP: { fn: 'exp', arity: 1 },
  LOG: { fn: 'log', arity: 1 },
  LOG2: { fn: 'log2', arity: 1 },
  LOG10: { fn: 'log10', arity: 1 },
  ODD: { fn: 'odd', arity: 1 },
  BLENGTH: { fn: 'blength', arity: 1 },
  LENGTH: { fn: 'length', arity: 1 },
};

const UNSUPPORTED_BUILTINS = new Set(['VALUE', 'VALUE_IN', 'VALUE_UNIQUE', 'ROLESOF', 'FORMAT', 'INSERT', 'REMOVE']);

const BINARY: Partial<Record<BinaryOp, string>> = {
  '=': 'eq', '<>': 'ne', ':=:': 'same', ':<>:': 'notSame', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge', IN: 'isIn',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', DIV: 'intDiv', MOD: 'mod', '**': 'pow', XOR: 'xor',
};

export class ExpressionTranslator {
  constructor(readonly ctx: TranslateContext) {}

  private get index() {
    return this.ctx.index;
  }

  /** `'IFC4.IFCWALL'` and `'IFC4.IFCWALL.ATTR'` literals, normalised to the qualifier TYPEOF returns. */
  private typeLiteral(value: string): string | undefined {
    const m = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(\.[A-Za-z0-9_]+)?$/.exec(value);
    if (!m || (!this.index.entity(m[2]) && !this.index.type(m[2]))) return undefined;
    return `${this.index.typePrefix}.${m[2].toUpperCase()}${(m[3] ?? '').toUpperCase()}`;
  }

  translate(e: Expr, scope: Scope): string {
    switch (e.k) {
      case 'num': return String(e.value);
      case 'str': return JSON.stringify(this.typeLiteral(e.value) ?? e.value);
      case 'logical': return e.value === 'TRUE' ? 'true' : e.value === 'FALSE' ? 'false' : 'r.UNKNOWN';
      case 'indeterminate': return 'undefined';
      case 'self':
        if (scope.kind === 'function' || scope.kind === 'rule') throw new UnsupportedConstruct('SELF outside an entity or type');
        return 'self';
      case 'const': return e.name === 'PI' ? 'Math.PI' : 'Math.E';
      case 'id': return this.identifier(e.name, scope);
      case 'attr': return this.attribute(e, scope);
      case 'group':
        if (!this.index.entity(e.entity)) throw new UnsupportedConstruct(`group qualifier names unknown entity ${e.entity}`);
        return this.translate(e.base, scope);
      case 'index':
        return e.upper
          ? `r.slice(${this.translate(e.base, scope)}, ${this.translate(e.index, scope)}, ${this.translate(e.upper, scope)})`
          : `r.index(${this.translate(e.base, scope)}, ${this.translate(e.index, scope)})`;
      case 'call': return this.call(e.name, e.args, scope);
      case 'unary': {
        const operand = this.translate(e.operand, scope);
        return e.op === 'NOT' ? `r.not(${operand})` : e.op === '-' ? `r.neg(${operand})` : `r.pos(${operand})`;
      }
      case 'binary': return this.binary(e.op, e.left, e.right, scope);
      case 'aggregate': {
        const items = e.items.map((i) => (i.repeat
          ? `[${this.translate(i.value, scope)}, ${this.translate(i.repeat, scope)}]`
          : `[${this.translate(i.value, scope)}]`));
        return `r.aggregate([${items.join(', ')}])`;
      }
      case 'query': {
        const inner = scope.child();
        const js = this.ctx.fresh('q');
        inner.define(e.variable, js);
        return `r.query(${this.translate(e.source, scope)}, (${js}: r.Value) => ${this.translate(e.predicate, inner)})`;
      }
      case 'interval':
        return `r.interval(${this.translate(e.low, scope)}, '${e.op1}', ${this.translate(e.item, scope)}, '${e.op2}', ${this.translate(e.high, scope)})`;
    }
  }

  private identifier(name: string, scope: Scope): string {
    const v = scope.lookup(name);
    if (v) return v.js;
    const upper = name.toUpperCase();
    if (scope.entity) {
      const kind = this.index.attributesOf(scope.entity).get(upper);
      if (kind) {
        if (kind === 'derived') this.ctx.checkDerived(upper);
        return `r.attr(self, ${JSON.stringify(upper)})`;
      }
    }
    if (this.index.enumItems.has(upper)) return this.ctx.enumLiteral(upper);
    throw new UnsupportedConstruct(`unresolved identifier ${name}`);
  }

  private attribute(e: Extract<Expr, { k: 'attr' }>, scope: Scope): string {
    if (e.base.k === 'id' && !scope.lookup(e.base.name) && this.index.isEnumeration(e.base.name)) {
      const decl = this.index.type(e.base.name)!;
      const items = decl.spec.k === 'enumeration' ? decl.spec.items.map((i) => i.toUpperCase()) : [];
      if (!items.includes(e.name.toUpperCase())) throw new UnsupportedConstruct(`${e.base.name} has no item ${e.name}`);
      return this.ctx.enumLiteral(e.name);
    }
    const upper = e.name.toUpperCase();
    if (!this.index.attributeNames.has(upper)) throw new UnsupportedConstruct(`no entity declares attribute ${e.name}`);
    this.ctx.checkDerived(upper);
    return `r.attr(${this.translate(e.base, scope)}, ${JSON.stringify(upper)})`;
  }

  private call(name: string, args: Expr[], scope: Scope): string {
    const upper = name.toUpperCase();
    const js = args.map((a) => this.translate(a, scope));
    const builtin = BUILTINS[upper];
    if (builtin) {
      if (js.length !== builtin.arity) throw new UnsupportedConstruct(`${upper} called with ${js.length} arguments`);
      return `r.${builtin.fn}(${builtin.model ? ['m', ...js].join(', ') : js.join(', ')})`;
    }
    if (UNSUPPORTED_BUILTINS.has(upper)) throw new UnsupportedConstruct(`built-in ${upper} is not implemented`);
    const fn = this.index.function(name);
    if (fn) {
      const reason = this.ctx.unsupportedFunctions.get(fn.name.toUpperCase());
      if (reason !== undefined) throw new UnsupportedConstruct(`calls ${fn.name}, which did not compile: ${reason}`);
      this.ctx.calls.add(fn.name.toUpperCase());
      return `${functionIdentifier(fn.name)}(${['m', ...js].join(', ')})`;
    }
    const entity = this.index.entity(name);
    if (entity) return `r.construct(m, ${JSON.stringify(entity.name)}, [${js.join(', ')}])`;
    const type = this.index.type(name);
    if (type) {
      if (js.length !== 1) throw new UnsupportedConstruct(`type constructor ${name} with ${js.length} arguments`);
      return `r.typed(m, ${JSON.stringify(type.name)}, ${js[0]})`;
    }
    throw new UnsupportedConstruct(`call to unknown function ${name}`);
  }

  private complexParts(e: Expr, out: Expr[]): Expr[] {
    if (e.k === 'binary' && e.op === '||') {
      this.complexParts(e.left, out);
      this.complexParts(e.right, out);
    } else {
      out.push(e);
    }
    return out;
  }

  private binary(op: BinaryOp, left: Expr, right: Expr, scope: Scope): string {
    if (op === 'IN' && left.k === 'str' && right.k === 'call' && right.name.toUpperCase() === 'TYPEOF' && right.args.length === 1) {
      const literal = this.typeLiteral(left.value);
      if (literal) {
        const name = literal.slice(literal.lastIndexOf('.') + 1);
        return `r.typeIs(m, ${this.translate(right.args[0], scope)}, ${JSON.stringify(name)})`;
      }
    }
    if (op === '||') {
      const parts = this.complexParts({ k: 'binary', op, left, right }, []).map((p) => this.translate(p, scope));
      return `r.complex(m, [${parts.join(', ')}])`;
    }
    if (op === 'AND' || op === 'OR') {
      return `r.${op === 'AND' ? 'and' : 'or'}(${this.translate(left, scope)}, () => ${this.translate(right, scope)})`;
    }
    const fn = BINARY[op];
    if (!fn) throw new UnsupportedConstruct(`operator ${op} is not implemented`);
    return `r.${fn}(${this.translate(left, scope)}, ${this.translate(right, scope)})`;
  }
}
