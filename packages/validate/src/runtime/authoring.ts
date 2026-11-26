/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridges the zod authoring form (`{ ref }`, enum items as strings,
 * `{ typed: { type, value } }`) to compiled rules, so generated zod schemas
 * can refine with them. Structural only: no zod import here.
 */

import { eq } from './compare.js';
import { EntityInstance } from './instance.js';
import { violated } from './logic.js';
import { Model } from './model.js';
import type { TypeRef } from './schema-meta.js';
import type { SchemaRuntime } from './schema-runtime.js';
import { EnumValue, Ref, StepInteger, Typed, UNKNOWN, withLowerBound, markSet, type Value } from './values.js';

export interface RefinementContext {
  addIssue(issue: { code: 'custom'; message: string; input?: unknown }): void;
}

const detached = new WeakMap<SchemaRuntime, Model>();

/** A model with no records, for rules evaluated outside any population. */
export function detachedModel(schema: SchemaRuntime): Model {
  let m = detached.get(schema);
  if (!m) detached.set(schema, (m = new Model(schema, { ids: () => [], type: () => undefined, text: () => undefined })));
  return m;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fromAuthoring(schema: Pick<SchemaRuntime, 'canonicalName' | 'type' | 'aggregateType'>, type: TypeRef | undefined, v: unknown): Value {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const aggregate = schema.aggregateType(type);
    const items = v.map(x => fromAuthoring(schema, aggregate?.of, x));
    if (aggregate?.kind === 'ARRAY' && aggregate.low !== undefined) return withLowerBound(items, aggregate.low);
    return aggregate?.kind === 'SET' ? markSet(items) : items;
  }
  if (isObject(v)) {
    if (typeof v.ref === 'number') return new Ref(v.ref);
    if (isObject(v.typed) && typeof v.typed.type === 'string') {
      const name = schema.canonicalName(v.typed.type) ?? v.typed.type;
      return new Typed(name, fromAuthoring(schema, { k: 'named', name }, v.typed.value));
    }
    return undefined;
  }
  if (v === 'UNKNOWN' && type?.k === 'simple' && type.name === 'LOGICAL') return UNKNOWN;
  if (typeof v === 'string' && type?.k === 'named' && schema.type(type.name)?.kind === 'enum') return new EnumValue(v.toUpperCase());
  if (typeof v === 'number' && Number.isInteger(v) && resolvesTo(schema, type, 'INTEGER')) return new StepInteger(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return undefined;
}

function resolvesTo(schema: Pick<SchemaRuntime, 'type'>, type: TypeRef | undefined, simple: string): boolean {
  for (let t = type, guard = 0; t && guard < 16; guard++) {
    if (t.k === 'simple') return t.name === simple;
    if (t.k !== 'named') return false;
    const decl = schema.type(t.name);
    t = decl?.kind === 'defined' ? decl.underlying : undefined;
  }
  return false;
}

/** zod `superRefine` callback running a defined type's WHERE rules (and those of the types it is based on). */
export function typeRuleRefinement(schema: SchemaRuntime, typeName: string): (value: unknown, ctx: RefinementContext) => void {
  return (value, ctx) => {
    const v = fromAuthoring(schema, { k: 'named', name: typeName }, value);
    const m = detachedModel(schema);
    for (const { declaredBy, rule } of schema.typeRules.get(typeName.toUpperCase()) ?? []) {
      if (violated(rule.check(v, m))) ctx.addIssue({ code: 'custom', message: `${declaredBy}.${rule.label}: ${rule.source}`, input: value });
    }
  };
}

/** zod `superRefine` callback running an entity's locally decidable WHERE rules on an authoring object. */
export function localRuleRefinement(schema: SchemaRuntime, entityName: string, labels: string[]): (value: unknown, ctx: RefinementContext) => void {
  const wanted = new Set(labels);
  return (value, ctx) => {
    const entity = schema.entity(entityName);
    if (!entity || !isObject(value)) return;
    const m = detachedModel(schema);
    const values = entity.attributes.map((a) => fromAuthoring(schema, a.type, value[a.name]));
    const inst = new EntityInstance(m, -1, entity, values, true);
    for (const { declaredBy, rule } of entity.rules) {
      const id = `${declaredBy}.${rule.label}`;
      if (wanted.has(id) && violated(rule.check(inst, m))) ctx.addIssue({ code: 'custom', message: `${id}: ${rule.source}`, input: value });
    }
  };
}

const SCALAR = {
  aggregateType: () => undefined,
  canonicalName: () => undefined,
  type: () => undefined,
};

export function uniqueItems(items: unknown[]): boolean {
  const values = items.map((x) => fromAuthoring(SCALAR, undefined, x));
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i];
      const b = values[j];
      if (a instanceof Ref && b instanceof Ref ? a.id === b.id : eq(a, b) === true) return false;
    }
  }
  return true;
}
