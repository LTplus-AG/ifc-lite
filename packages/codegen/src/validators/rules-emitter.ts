/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compiles every WHERE rule, DERIVE expression, FUNCTION and global RULE of a
 * schema into one TypeScript module. A construct the translator cannot
 * compile lands in `unsupported` with its reason, so the runtime reports the
 * rule as not evaluated instead of passing it.
 */

import type { EntityDecl } from '../express/ast.js';
import { ExpressionTranslator } from './expr-translator.js';
import type { SchemaIndex } from './schema-index.js';
import { StatementTranslator } from './stmt-translator.js';
import { Scope, TranslateContext, UnsupportedConstruct } from './translate-context.js';

export interface UnsupportedEntry {
  scope: 'entity' | 'type' | 'derived' | 'global' | 'function' | 'schema';
  owner: string;
  label: string;
  reason: string;
}

export interface RuleCompilation {
  source: string;
  unsupported: UnsupportedEntry[];
  counts: Record<'entity' | 'type' | 'derived' | 'global' | 'function', { total: number; compiled: number }>;
}

function reasonOf(e: unknown): string {
  if (e instanceof UnsupportedConstruct) return e.message;
  throw e;
}

function compileFunctions(index: SchemaIndex, ctx: TranslateContext, stmts: StatementTranslator): Map<string, string> {
  const unsupported = ctx.unsupportedFunctions;
  const compiled = new Map<string, { source: string; calls: Set<string> }>();
  for (const fn of index.schema.functions) {
    ctx.calls = new Set();
    try {
      compiled.set(fn.name.toUpperCase(), { source: stmts.functionSource(fn), calls: ctx.calls });
    } catch (e) {
      unsupported.set(fn.name.toUpperCase(), reasonOf(e));
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of compiled) {
      const bad = [...fn.calls].find((c) => unsupported.has(c));
      if (!bad) continue;
      unsupported.set(name, `calls ${index.function(bad)?.name ?? bad}, which did not compile`);
      compiled.delete(name);
      changed = true;
    }
  }
  return new Map([...compiled].map(([k, v]) => [k, v.source]));
}

function indent(text: string, pad: string): string {
  return text.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

/**
 * A FUNCTION, or a DERIVE declared earlier, can read a DERIVE that only fails
 * later in the pass. Compile again with the failed DERIVEs known up front until
 * the set stops growing; the bundled schemas have none, so one pass.
 */
export function compileRules(index: SchemaIndex, header: string, runtimeImport: string): RuleCompilation {
  let known = new Map<string, string>();
  for (;;) {
    const pass = compilePass(index, header, runtimeImport, known);
    if (pass.failedDerived.size === known.size) return pass.compilation;
    known = pass.failedDerived;
  }
}

function compilePass(
  index: SchemaIndex, header: string, runtimeImport: string, knownFailedDerived: Map<string, string>,
): { compilation: RuleCompilation; failedDerived: Map<string, string> } {
  const unsupportedFunctions = new Map<string, string>();
  const ctx = new TranslateContext(index, unsupportedFunctions);
  for (const [name, qualified] of knownFailedDerived) ctx.failedDerived.set(name, qualified);
  const expr = new ExpressionTranslator(ctx);
  const stmts = new StatementTranslator(expr);
  const functions = compileFunctions(index, ctx, stmts);
  const unsupported: UnsupportedEntry[] = index.schema.skipped.map(({ kind, name }) => ({
    scope: 'schema', owner: index.schema.name, label: name || kind, reason: `${kind} declaration is not evaluated`,
  }));
  for (const label of index.unsupportedBounds) {
    unsupported.push({ scope: 'schema', owner: index.schema.name, label, reason: 'bound is not a supported constant integer expression' });
  }
  const counts: RuleCompilation['counts'] = {
    entity: { total: 0, compiled: 0 }, type: { total: 0, compiled: 0 }, derived: { total: 0, compiled: 0 },
    global: { total: 0, compiled: 0 }, function: { total: index.schema.functions.length, compiled: functions.size },
  };
  for (const fn of index.schema.functions) {
    const reason = unsupportedFunctions.get(fn.name.toUpperCase());
    if (reason !== undefined) unsupported.push({ scope: 'function', owner: fn.name, label: fn.name, reason });
  }

  const derived: string[] = [];
  for (const e of index.schema.entities) {
    for (const d of e.derived) {
      counts.derived.total++;
      try {
        derived.push(`    ${JSON.stringify(`${e.name}.${d.redeclares?.attribute ?? d.name}`)}: (self: r.EntityInstance, m: r.Model): r.Value => ${expr.translate(d.expr, new Scope('entity', e))},`);
        counts.derived.compiled++;
      } catch (err) {
        const reason = reasonOf(err);
        ctx.failedDerived.set(`${e.name}.${d.name}`.toUpperCase(), `${e.name}.${d.name}`);
        unsupported.push({ scope: 'derived', owner: e.name, label: d.name, reason });
      }
    }
  }

  const entityRules: string[] = [];
  for (const e of index.schema.entities) {
    const rules = entityRuleSources(e, expr, unsupported, counts);
    if (rules.length) entityRules.push(`    ${JSON.stringify(e.name)}: [\n${rules.join('\n')}\n    ],`);
  }

  const typeRules: string[] = [];
  for (const t of index.schema.types) {
    const rules: string[] = [];
    for (const w of t.where) {
      counts.type.total++;
      try {
        rules.push(`      { label: ${JSON.stringify(w.label)}, source: ${JSON.stringify(w.source)}, check: (self: r.Value, m: r.Model): r.Value => ${expr.translate(w.expr, new Scope('type'))} },`);
        counts.type.compiled++;
      } catch (err) {
        unsupported.push({ scope: 'type', owner: t.name, label: w.label, reason: reasonOf(err) });
      }
    }
    if (rules.length) typeRules.push(`    ${JSON.stringify(t.name)}: [\n${rules.join('\n')}\n    ],`);
  }

  const globalRules: string[] = [];
  for (const rule of index.schema.rules) {
    counts.global.total += rule.where.length;
    const supported: typeof rule.where = [];
    let run: string;
    try {
      run = stmts.ruleSource(rule, (w, compile) => {
        try {
          const value = compile();
          supported.push(w);
          return [value];
        } catch (err) {
          unsupported.push({ scope: 'global', owner: rule.name, label: w.label, reason: reasonOf(err) });
          return [];
        }
      });
    } catch (err) {
      const reason = reasonOf(err);
      for (const w of rule.where) unsupported.push({ scope: 'global', owner: rule.name, label: w.label, reason });
      continue;
    }
    if (!supported.length) continue;
    const labels = supported.map((w) => `{ label: ${JSON.stringify(w.label)}, source: ${JSON.stringify(w.source)} }`);
    globalRules.push(`    { name: ${JSON.stringify(rule.name)}, appliesTo: ${JSON.stringify(rule.appliesTo.map((a) => index.canonical(a) ?? a))}, rules: [${labels.join(', ')}], run: ${indent(run, '  ')} },`);
    counts.global.compiled += supported.length;
  }

  const constants = [...ctx.constants].map(([name, init]) => `const ${name} = ${init};`);
  const fnSources = index.schema.functions.map((f) => functions.get(f.name.toUpperCase())).filter((s): s is string => !!s);
  const source = `${header}
import * as r from ${JSON.stringify(runtimeImport)};

${constants.join('\n')}

${fnSources.join('\n\n')}

export const RULES: r.CompiledRules = {
  entity: {
${entityRules.join('\n')}
  },
  type: {
${typeRules.join('\n')}
  },
  derived: {
${derived.join('\n')}
  },
  global: [
${globalRules.join('\n')}
  ],
  unsupported: ${JSON.stringify(unsupported, null, 1).replace(/\n/g, '\n  ')},
};
`;
  return { compilation: { source, unsupported, counts }, failedDerived: ctx.failedDerived };
}

function entityRuleSources(
  e: EntityDecl,
  expr: ExpressionTranslator,
  unsupported: UnsupportedEntry[],
  counts: RuleCompilation['counts'],
): string[] {
  const out: string[] = [];
  for (const w of e.where) {
    counts.entity.total++;
    try {
      out.push(`      { label: ${JSON.stringify(w.label)}, source: ${JSON.stringify(w.source)}, check: (self: r.EntityInstance, m: r.Model): r.Value => ${expr.translate(w.expr, new Scope('entity', e))} },`);
      counts.entity.compiled++;
    } catch (err) {
      unsupported.push({ scope: 'entity', owner: e.name, label: w.label, reason: reasonOf(err) });
    }
  }
  return out;
}
