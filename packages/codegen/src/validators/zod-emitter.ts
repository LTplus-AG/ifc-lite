/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emits zod 4 schemas for the authoring form of every type and entity:
 * attributes by EXPRESS name, entity references as `{ ref }`, enumerations
 * as their item, defined-type values in a SELECT as `{ typed: { type, value } }`
 * (the `@ifc-lite/data` convention), aggregates as arrays. Defined types carry
 * their WHERE rules and entities the WHERE rules decidable from their own
 * attributes, as refinements.
 */

import type { EntityDecl, TypeDecl, TypeSpec } from '../express/ast.js';
import { isLocalRule } from './local-rules.js';
import { literalInt } from './meta-emitter.js';
import type { SchemaIndex } from './schema-index.js';

class ZodWriter {
  private readonly deferred = new Set<string>();

  constructor(readonly index: SchemaIndex) {}

  /** Select members flattened through nested selects: entity names and value-type names. */
  selectLeaves(name: string, seen = new Set<string>()): { entities: boolean; values: string[] } {
    const out = { entities: false, values: [] as string[] };
    const decl = this.index.type(name);
    if (!decl || decl.spec.k !== 'select' || seen.has(decl.name)) return out;
    seen.add(decl.name);
    for (const item of decl.spec.items) {
      if (this.index.entity(item)) out.entities = true;
      const t = this.index.type(item);
      if (!t) continue;
      if (t.spec.k === 'select') {
        const inner = this.selectLeaves(t.name, seen);
        out.entities ||= inner.entities;
        for (const v of inner.values) if (!out.values.includes(v)) out.values.push(v);
      } else if (!out.values.includes(t.name)) {
        out.values.push(t.name);
      }
    }
    return out;
  }

  spec(spec: TypeSpec): string {
    switch (spec.k) {
      case 'simple': {
        const width = literalInt(spec.width);
        switch (spec.name) {
          case 'REAL': case 'NUMBER': return 'z.number()';
          case 'INTEGER': return 'z.number().int()';
          case 'BOOLEAN': return 'z.boolean()';
          case 'LOGICAL': return "z.union([z.boolean(), z.literal('UNKNOWN')])";
          case 'BINARY': {
            const base = 'z.string().regex(/^(?:0|1[0-7]|2[0-3]|3[01])[0-9A-Fa-f]*$/)';
            return width === undefined ? base : `${base}.refine(value => (value.length - 1) * 4 - Number(value[0]) ${spec.fixed ? '===' : '<='} ${width}, 'invalid BINARY bit length')`;
          }
          default: return width === undefined ? 'z.string()' : `z.string().${spec.fixed ? 'length' : 'max'}(${width})`;
        }
      }
      case 'named': {
        if (this.index.entity(spec.name)) return '$EntityRef';
        const t = this.index.type(spec.name);
        return t ? t.name : 'z.unknown()';
      }
      case 'aggregate': {
        const low = literalInt(spec.low);
        const high = literalInt(spec.high);
        let inner = this.spec(spec.of);
        if (spec.optional) inner += '.nullable()';
        let out = `z.array(${inner})`;
        if (spec.kind === 'ARRAY') {
          if (low !== undefined && high !== undefined) out += `.length(${high - low + 1})`;
        } else {
          if (low !== undefined && low > 0) out += `.min(${low})`;
          if (high !== undefined) out += `.max(${high})`;
        }
        if (spec.kind === 'SET' || spec.unique) out += ".refine(r.uniqueItems, 'aggregate items must be unique')";
        return out;
      }
      default:
        return 'z.unknown()';
    }
  }

  private baseType(t: TypeDecl): string {
    if (t.spec.k === 'enumeration') return `z.enum(${JSON.stringify(t.spec.items.map((i) => i.toUpperCase()))})`;
    if (t.spec.k === 'select') {
      const leaves = this.selectLeaves(t.name);
      const members = leaves.values.map((v) => `$typed(${JSON.stringify(v)}, ${v})`);
      if (leaves.entities) members.unshift('$EntityRef');
      return members.length === 1 ? members[0] : `z.union([${members.join(', ')}])`;
    }
    return this.spec(t.spec);
  }

  typeDecl(t: TypeDecl): string {
    const base = this.baseType(t);
    const schema = t.where.length ? `${base}.superRefine(r.typeRuleRefinement(SCHEMA, ${JSON.stringify(t.name)}))` : base;
    return this.deferred.has(t.name)
      ? `export const ${t.name}: z.ZodType = z.lazy(() => ${schema});`
      : `export const ${t.name} = ${schema};`;
  }

  /** Type declarations ordered so each schema is defined before it is referenced. */
  orderedTypes(): TypeDecl[] {
    const out: TypeDecl[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (t: TypeDecl) => {
      if (state.get(t.name)) return;
      state.set(t.name, 'visiting');
      for (const dep of this.dependencies(t)) {
        const d = this.index.type(dep);
        if (!d) continue;
        if (state.get(d.name) === 'visiting') this.deferred.add(t.name);
        else visit(d);
      }
      state.set(t.name, 'done');
      out.push(t);
    };
    for (const t of this.index.schema.types) visit(t);
    return out;
  }

  private dependencies(t: TypeDecl): string[] {
    if (t.spec.k === 'select') return this.selectLeaves(t.name).values;
    const deps: string[] = [];
    const walk = (s: TypeSpec) => {
      if (s.k === 'named') deps.push(s.name);
      else if (s.k === 'aggregate') walk(s.of);
    };
    walk(t.spec);
    return deps;
  }

  entity(e: EntityDecl): { schema: string; localRules: string[] } {
    const chain = this.index.chain(e);
    // A redeclaration changes the name/type of an existing positional slot.
    const slots = new Map<string, { name: string; type: TypeSpec; optional: boolean }>();
    const origins = new Map<string, string>();
    for (const level of chain) {
      for (const a of level.explicit) {
        const name = a.name.toUpperCase();
        const previous = a.redeclares?.attribute.toUpperCase() ?? name;
        const origin = origins.get(previous) ?? previous;
        slots.set(origin, a);
        origins.set(name, origin);
      }
      for (const d of level.derived) {
        const previous = d.redeclares?.attribute.toUpperCase();
        if (previous) slots.delete(origins.get(previous) ?? previous);
      }
    }
    const fields = [...slots.values()].map(a =>
      `  ${a.name}: ${this.spec(a.type)}${a.optional ? '.nullish()' : ''},`);
    const localRules = chain.flatMap((level) => level.where
      // Attribute kinds come from the concrete entity: a subtype may redeclare an explicit attribute as DERIVE.
      .filter((w) => isLocalRule(w.expr, e, this.index))
      .map((w) => `${level.name}.${w.label}`));
    let schema = `z.strictObject({\n${fields.join('\n')}\n})`;
    if (localRules.length) schema += `.superRefine(r.localRuleRefinement(SCHEMA, ${JSON.stringify(e.name)}, ${JSON.stringify(localRules)}))`;
    return { schema, localRules };
  }
}

export function emitZodSchemas(index: SchemaIndex, header: string, runtimeImport: string, zodImport: string): string {
  const w = new ZodWriter(index);
  const types = w.orderedTypes().map((t) => w.typeDecl(t));
  const entities = index.schema.entities.map((e) => `export const ${e.name} = ${w.entity(e).schema};`);
  return `${header}
import { z } from ${JSON.stringify(zodImport)};
import * as r from ${JSON.stringify(runtimeImport)};
import { SCHEMA } from './index.js';

const $EntityRef = z.strictObject({ ref: z.number().int().positive() });

${index.canonical('EntityRef') ? '' : 'export { $EntityRef as EntityRef };'}

function $typed<T extends string, S extends z.ZodType>(type: T, value: S) {
  return z.strictObject({ typed: z.strictObject({ type: z.literal(type), value }) });
}

${types.join('\n')}

${entities.join('\n')}
`;
}
