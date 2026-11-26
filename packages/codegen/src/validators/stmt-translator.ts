/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS statements, FUNCTION and RULE bodies -> TypeScript. */

import type { Expr, FunctionDecl, LocalVariable, RuleDecl, Stmt, TypeSpec } from '../express/ast.js';
import { ExpressionTranslator } from './expr-translator.js';
import { functionIdentifier, jsIdentifier, Scope, UnsupportedConstruct } from './translate-context.js';

const INDENT = '  ';

export class StatementTranslator {
  constructor(readonly expr: ExpressionTranslator) {}

  private t(e: Expr, scope: Scope): string {
    return this.expr.translate(e, scope);
  }

  private assignment(target: Expr, value: Expr, scope: Scope): string {
    const v = this.t(value, scope);
    switch (target.k) {
      case 'id': {
        const variable = scope.lookup(target.name);
        if (!variable) throw new UnsupportedConstruct(`assignment to undeclared ${target.name}`);
        return `${variable.js} = ${this.coerce(v, variable.type, scope)};`;
      }
      case 'index':
        if (target.upper) throw new UnsupportedConstruct('assignment to an aggregate slice');
        return `r.setIndex(${this.t(target.base, scope)}, ${this.t(target.index, scope)}, ${v});`;
      case 'attr':
        return `r.setAttr(${this.t(target.base, scope)}, ${JSON.stringify(target.name.toUpperCase())}, ${v});`;
      case 'group':
        return this.assignment(target.base, value, scope);
      default:
        throw new UnsupportedConstruct(`assignment target ${target.k}`);
    }
  }

  statements(body: Stmt[], scope: Scope, depth: number): string[] {
    return body.flatMap((s) => this.statement(s, scope, depth));
  }

  private statement(s: Stmt, scope: Scope, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    switch (s.k) {
      case 'null': return [];
      case 'assign': return [pad + this.assignment(s.target, s.value, scope)];
      case 'return': return [`${pad}return ${s.value ? this.t(s.value, scope) : 'undefined'};`];
      case 'escape':
        if (!scope.loop) throw new UnsupportedConstruct('ESCAPE outside REPEAT');
        return [`${pad}break;`];
      case 'skip': {
        // SKIP leaves the body but still runs the UNTIL test, so it breaks out of a labelled body block.
        if (!scope.loop) throw new UnsupportedConstruct('SKIP outside REPEAT');
        scope.loop.label ??= this.expr.ctx.fresh('body');
        return [`${pad}break ${scope.loop.label};`];
      }
      case 'block': return [`${pad}{`, ...this.statements(s.body, scope, depth + 1), `${pad}}`];
      case 'if': {
        const out = [`${pad}if (r.isTrue(${this.t(s.cond, scope)})) {`, ...this.statements(s.thenBody, scope, depth + 1)];
        if (s.elseBody) out.push(`${pad}} else {`, ...this.statements(s.elseBody, scope, depth + 1));
        out.push(`${pad}}`);
        return out;
      }
      case 'case': {
        const sel = this.expr.ctx.fresh('sel');
        const out = [`${pad}{`, `${pad}${INDENT}const ${sel} = r.caseSelector(${this.t(s.selector, scope)});`];
        s.branches.forEach((b, i) => {
          const test = b.labels.map((l) => `r.isTrue(r.eq(${sel}, ${this.t(l, scope)}))`).join(' || ');
          out.push(`${pad}${INDENT}${i === 0 ? 'if' : '} else if'} (${test}) {`, ...this.statements([b.body], scope, depth + 2));
        });
        if (s.otherwise) {
          out.push(s.branches.length ? `${pad}${INDENT}} else {` : `${pad}${INDENT}{`, ...this.statements([s.otherwise], scope, depth + 2));
        }
        if (s.branches.length || s.otherwise) out.push(`${pad}${INDENT}}`);
        out.push(`${pad}}`);
        return out;
      }
      case 'repeat': return this.repeat(s, scope, depth);
      case 'procedure': throw new UnsupportedConstruct(`procedure call ${s.name}`);
      case 'alias': throw new UnsupportedConstruct('ALIAS statement');
    }
  }

  private repeat(s: Extract<Stmt, { k: 'repeat' }>, scope: Scope, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    const loop: { label?: string } = {};
    const inner = scope.child(loop);
    const counted = s.variable && s.from && s.to;
    const v = counted ? inner.define(s.variable!, this.expr.ctx.fresh(jsIdentifier('i_', s.variable!))).js : '';
    const bodyPad = pad + INDENT.repeat(counted ? 2 : 1);
    const guard = s.whileCond ? [`${bodyPad}if (!r.isTrue(${this.t(s.whileCond, inner)})) break;`] : [];
    const tail = s.untilCond ? [`${bodyPad}if (r.isTrue(${this.t(s.untilCond, inner)})) break;`] : [];
    let body = this.statements(s.body, inner, depth + (counted ? 2 : 1));
    if (loop.label) body = [`${bodyPad}${loop.label}: {`, ...body.map((l) => INDENT + l), `${bodyPad}}`];
    if (!counted) {
      if (!s.whileCond && !s.untilCond) throw new UnsupportedConstruct('REPEAT without increment, WHILE or UNTIL');
      return [`${pad}for (;;) {`, ...guard, ...body, ...tail, `${pad}}`];
    }
    const [f, to, by] = [this.expr.ctx.fresh('from'), this.expr.ctx.fresh('to'), this.expr.ctx.fresh('by')];
    return [
      `${pad}{`,
      `${pad}${INDENT}const ${f} = r.int(${this.t(s.from!, scope)}), ${to} = r.int(${this.t(s.to!, scope)}), ${by} = ${s.by ? `r.int(${this.t(s.by, scope)})` : '1'};`,
      `${pad}${INDENT}if (${f} !== undefined && ${to} !== undefined && ${by}) for (let ${v} = ${f}; ${by} > 0 ? ${v} <= ${to} : ${v} >= ${to}; ${v} += ${by}) {`,
      ...guard,
      ...body,
      ...tail,
      `${pad}${INDENT}}`,
      `${pad}}`,
    ];
  }

  /** Value semantics of assignment to a variable of `type`: ARRAY bounds and SET uniqueness carry over. */
  private coerce(value: string, type: TypeSpec | undefined, scope: Scope): string {
    if (type?.k === 'aggregate' && type.kind === 'ARRAY' && type.low) return `r.assignArray(${value}, ${this.t(type.low, scope)})`;
    if (type?.k === 'aggregate' && type.kind === 'SET') return `r.assignSet(${value})`;
    return `r.assign(${value})`;
  }

  private locals(locals: LocalVariable[], scope: Scope, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    return locals.map((l) => {
      const js = scope.define(l.name, jsIdentifier('v_', l.name), l.type).js;
      if (!l.init) return `${pad}let ${js}: r.Value = undefined;`;
      return `${pad}let ${js}: r.Value = ${this.coerce(this.t(l.init, scope), l.type, scope)};`;
    });
  }

  functionSource(fn: FunctionDecl): string {
    const scope = new Scope('function');
    const params = fn.params.map((p) => `${scope.define(p.name, jsIdentifier('p_', p.name), p.type).js}: r.Value`);
    const setParams = fn.params
      .filter((p) => p.type.k === 'aggregate' && p.type.kind === 'SET')
      .map((p) => `  ${scope.lookup(p.name)!.js} = r.assignSet(${scope.lookup(p.name)!.js});`);
    const body = [...setParams, ...this.locals(fn.locals, scope, 1), ...this.statements(fn.body, scope, 1)];
    return [
      `function ${functionIdentifier(fn.name)}(${['m: r.Model', ...params].join(', ')}): r.Value {`,
      ...body,
      '  return undefined;',
      '}',
    ].join('\n');
  }

  /** A global RULE as `(m) => [[label, result], ...]`. */
  ruleSource(rule: RuleDecl): string {
    const scope = new Scope('rule');
    const pops = rule.appliesTo.map((name) => {
      const entity = this.expr.ctx.index.entity(name);
      if (!entity) throw new UnsupportedConstruct(`RULE ${rule.name} applies to unknown entity ${name}`);
      const js = scope.define(name, jsIdentifier('pop_', name)).js;
      return `    const ${js}: r.Value = m.population(${JSON.stringify(entity.name)});`;
    });
    const body = [...this.locals(rule.locals, scope, 2), ...this.statements(rule.body, scope, 2)];
    const results = rule.where.map((w) => `[${JSON.stringify(w.label)}, ${this.t(w.expr, scope)}]`);
    return [
      '(m: r.Model): Array<[string, r.Value]> => {',
      ...pops,
      ...body,
      `    return [${results.join(', ')}];`,
      '  }',
    ].join('\n');
  }
}
