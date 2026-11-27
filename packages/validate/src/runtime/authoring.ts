/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridges the zod authoring form (`{ ref }`, enum items as strings,
 * `{ typed: { type, value } }`) to compiled rules, so generated zod schemas
 * can refine with them. Structural only: no zod import here.
 */

import { uniqueAggregate } from './unique-aggregate.js';
import { EntityInstance } from './instance.js';
import { violated } from './logic.js';
import { Model } from './model.js';
import type { TypeRef } from './schema-meta.js';
import { underlyingType, type SchemaRuntime } from './schema-runtime.js';
import { BinaryValue, EnumValue, Ref, StepInteger, StepReal, Typed, UNKNOWN, withLowerBound, markSet, type Value } from './values.js';

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
  const base = underlyingType(schema, type);
  const simple = base?.k === 'simple' ? base.name : undefined;
  if (typeof v === 'string' && simple === 'BINARY') return new BinaryValue(v);
  if (v === 'UNKNOWN' && simple === 'LOGICAL') return UNKNOWN;
  if (typeof v === 'string' && base?.k === 'named' && schema.type(base.name)?.kind === 'enum') return new EnumValue(v.toUpperCase());
  if (typeof v === 'number' && Number.isInteger(v)) {
    if (simple === 'INTEGER') return new StepInteger(v);
    if (simple === 'REAL') return new StepReal(v);
  }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return undefined;
}

function refineRule(ctx: RefinementContext, input: unknown, id: string, source: string, check: () => Value): void {
  let result: Value;
  try {
    result = check();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.addIssue({ code: 'custom', message: `${id}: evaluation_error: ${reason}`, input });
    return;
  }
  if (violated(result)) ctx.addIssue({ code: 'custom', message: `${id}: ${source}`, input });
}

/** zod `superRefine` callback running a defined type's WHERE rules (and those of the types it is based on). */
export function typeRuleRefinement(schema: SchemaRuntime, typeName: string): (value: unknown, ctx: RefinementContext) => void {
  return (value, ctx) => {
    const v = fromAuthoring(schema, { k: 'named', name: typeName }, value);
    const m = detachedModel(schema);
    for (const { declaredBy, rule } of schema.typeRules.get(typeName.toUpperCase()) ?? []) {
      refineRule(ctx, value, `${declaredBy}.${rule.label}`, rule.source, () => rule.check(v, m));
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
      if (wanted.has(id)) refineRule(ctx, value, id, rule.source, () => rule.check(inst, m));
    }
  };
}

const SCALAR = {
  aggregateType: () => undefined,
  canonicalName: () => undefined,
  type: () => undefined,
};

export function uniqueItems(items: unknown[]): boolean {
  return uniqueAggregate(items.map(x => fromAuthoring(SCALAR, undefined, x)));
}
