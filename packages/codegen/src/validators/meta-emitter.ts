/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Emits the schema tables (`SchemaMeta` in `@ifc-lite/validate`) the validator runtime resolves. */

import type { EntityDecl, Expr, TypeDecl, TypeSpec } from '../express/ast.js';
import type { SchemaIndex } from './schema-index.js';

export type MetaTypeRef =
  | { k: 'simple'; name: string; width?: number; fixed?: boolean }
  | { k: 'named'; name: string }
  | { k: 'aggregate'; kind: 'LIST' | 'SET' | 'BAG' | 'ARRAY'; low: number; high?: number; unique: boolean; optional: boolean; of: MetaTypeRef }
  | { k: 'generic' };

/** An integer literal bound or width (`2`, `-1`); undefined for `?` or an expression. */
export function literalInt(e: Expr | undefined): number | undefined {
  if (!e) return undefined;
  if (e.k === 'num' && e.int) return e.value;
  if (e.k === 'indeterminate') return undefined;
  if (e.k === 'unary' && (e.op === '-' || e.op === '+')) {
    const n = literalInt(e.operand);
    if (n !== undefined) return e.op === '-' ? -n : n;
  }
  if (e.k === 'binary') {
    const a = literalInt(e.left), b = literalInt(e.right);
    if (a !== undefined && b !== undefined) {
      const n = e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : NaN;
      if (Number.isSafeInteger(n)) return n;
    }
  }
  throw new Error('Cannot emit a schema bound that is not a constant integer');
}

export function toTypeRef(spec: TypeSpec, index: SchemaIndex): MetaTypeRef {
  switch (spec.k) {
    case 'simple': {
      const width = literalInt(spec.width);
      return { k: 'simple', name: spec.name, ...(width !== undefined ? { width } : {}), ...(spec.fixed ? { fixed: true } : {}) };
    }
    case 'named': return { k: 'named', name: index.canonical(spec.name) ?? spec.name };
    case 'aggregate': {
      const high = literalInt(spec.high);
      return {
        k: 'aggregate',
        kind: spec.kind === 'AGGREGATE' ? 'BAG' : spec.kind,
        low: literalInt(spec.low) ?? 0,
        ...(high !== undefined ? { high } : {}),
        unique: spec.kind === 'SET' || spec.unique,
        optional: spec.optional,
        of: toTypeRef(spec.of, index),
      };
    }
    default: return { k: 'generic' };
  }
}

function entityMeta(e: EntityDecl, index: SchemaIndex): Record<string, unknown> {
  const own = e.explicit.filter((a) => !a.redeclares);
  const retyped = e.explicit.filter((a) => a.redeclares);
  const derivedRedeclarations = e.derived.filter((d) => d.redeclares && isInheritedExplicit(e, d.redeclares.attribute, index));
  const derived = e.derived.filter((d) => !derivedRedeclarations.includes(d));
  const meta: Record<string, unknown> = {
    name: e.name,
    abstract: e.abstract,
    attributes: own.map((a) => ({ name: a.name, type: toTypeRef(a.type, index), optional: a.optional })),
  };
  if (e.supertypes.length > 1) meta.supertypes = e.supertypes.map(name => index.canonical(name) ?? name);
  else if (e.supertypes[0]) meta.supertype = index.canonical(e.supertypes[0]) ?? e.supertypes[0];
  if (retyped.length) {
    meta.retyped = Object.fromEntries(retyped.map((a) => [a.redeclares!.attribute, { name: a.redeclares!.attribute, type: toTypeRef(a.type, index), optional: a.optional }]));
  }
  if (derivedRedeclarations.length) meta.derivedRedeclarations = derivedRedeclarations.map((d) => d.redeclares!.attribute);
  if (derived.length) meta.derived = derived.map((d) => d.name);
  if (e.inverse.length) {
    meta.inverse = e.inverse.map((i) => ({
      name: i.name,
      entity: index.canonical(i.entity) ?? i.entity,
      forAttribute: i.forAttribute,
      ...(i.aggregate ? { aggregate: i.aggregate } : {}),
      low: i.aggregate ? literalInt(i.low) ?? 0 : 1,
      ...(i.aggregate ? (literalInt(i.high) !== undefined ? { high: literalInt(i.high) } : {}) : { high: 1 }),
    }));
  }
  if (e.unique.length) meta.unique = e.unique.map((u) => ({ label: u.label, attributes: u.attributes.map((a) => a.name) }));
  return meta;
}

function isInheritedExplicit(e: EntityDecl, attribute: string, index: SchemaIndex): boolean {
  return index.chain(e).slice(0, -1).some((level) => level.explicit.some((a) => a.name.toUpperCase() === attribute.toUpperCase()));
}

function typeMeta(t: TypeDecl, index: SchemaIndex): Record<string, unknown> {
  if (t.spec.k === 'enumeration') return { kind: 'enum', name: t.name, items: t.spec.items.map((i) => i.toUpperCase()) };
  if (t.spec.k === 'select') return { kind: 'select', name: t.name, items: t.spec.items.map((i) => index.canonical(i) ?? i) };
  return { kind: 'defined', name: t.name, underlying: toTypeRef(t.spec, index) };
}

export function emitSchemaMeta(index: SchemaIndex, header: string, runtimeImport: string): string {
  const meta = {
    name: index.schema.name,
    typePrefix: index.typePrefix,
    entities: index.schema.entities.map((e) => entityMeta(e, index)),
    types: index.schema.types.map((t) => typeMeta(t, index)),
  };
  return `${header}
import type { SchemaMeta } from '${runtimeImport}';

export const META: SchemaMeta = ${JSON.stringify(meta, null, 1)};
`;
}
