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
          case 'BINARY': return 'z.string().regex(/^[0-3][0-9A-Fa-f]*$/)';
          default: return width === undefined ? 'z.string()' : `z.string().${spec.fixed ? 'length' : 'max'}(${width})`;
        }
      }
      case 'named': {
        if (this.index.entity(spec.name)) return 'EntityRef';
        const t = this.index.type(spec.name);
        return t ? t.name : 'z.unknown()';
      }
      case 'aggregate': {
        const low = literalInt(spec.low) ?? 0;
        const high = literalInt(spec.high);
        let inner = this.spec(spec.of);
        if (spec.optional) inner += '.nullable()';
        let out = `z.array(${inner})`;
        if (low > 0) out += `.min(${low})`;
        if (high !== undefined) out += `.max(${high})`;
        if (spec.unique) out += ".refine(r.uniqueItems, 'aggregate items must be unique')";
        return out;
      }
      default:
        return 'z.unknown()';
    }
  }

  typeDecl(t: TypeDecl): string {
    if (t.spec.k === 'enumeration') return `z.enum(${JSON.stringify(t.spec.items.map((i) => i.toUpperCase()))})`;
    if (t.spec.k === 'select') {
      const leaves = this.selectLeaves(t.name);
      const members = leaves.values.map((v) => `typed(${JSON.stringify(v)}, ${v})`);
      if (leaves.entities) members.unshift('EntityRef');
      return members.length === 1 ? members[0] : `z.union([${members.join(', ')}])`;
    }
    const base = this.spec(t.spec);
    return t.where.length ? `${base}.superRefine(r.typeRuleRefinement(SCHEMA, ${JSON.stringify(t.name)}))` : base;
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
        if (d && state.get(d.name) !== 'visiting') visit(d);
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
    const derived = new Set<string>();
    for (const level of chain) {
      for (const d of level.derived) if (d.redeclares) derived.add(d.redeclares.attribute.toUpperCase());
    }
    const fields: string[] = [];
    const retyped = new Map<string, { type: TypeSpec; optional: boolean }>();
    for (const level of chain) for (const a of level.explicit) if (a.redeclares) retyped.set(a.redeclares.attribute.toUpperCase(), a);
    for (const level of chain) {
      for (const a of level.explicit) {
        if (a.redeclares || derived.has(a.name.toUpperCase())) continue;
        const declared = retyped.get(a.name.toUpperCase()) ?? a;
        fields.push(`  ${a.name}: ${this.spec(declared.type)}${declared.optional ? '.nullish()' : ''},`);
      }
    }
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
  const types = w.orderedTypes().map((t) => `export const ${t.name} = ${w.typeDecl(t)};`);
  const entities = index.schema.entities.map((e) => `export const ${e.name} = ${w.entity(e).schema};`);
  return `${header}
import { z } from '${zodImport}';
import * as r from '${runtimeImport}';
import { SCHEMA } from './index.js';

export const EntityRef = z.strictObject({ ref: z.number().int().positive() });

function typed<T extends string, S extends z.ZodType>(type: T, value: S) {
  return z.strictObject({ typed: z.strictObject({ type: z.literal(type), value }) });
}

${types.join('\n')}

${entities.join('\n')}
`;
}
