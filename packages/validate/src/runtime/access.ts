/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Attribute access, indexing, entity constructors and assignment for compiled EXPRESS. */

import { EntityInstance } from './instance.js';
import type { TypeRef } from './schema-meta.js';
import type { SchemaRuntime } from './schema-runtime.js';
import type { Model } from './model.js';
import { uniqueMembers } from './arithmetic.js';
import { EvaluationError } from './errors.js';
import {
  copyAggregate, DERIVED, int, isAggregate, isSet, lowerBound, markSet, Ref, Typed, withLowerBound, type Aggregate, type Value,
} from './values.js';

export { EvaluationError } from './errors.js';

const IN_PROGRESS = Symbol('IN_PROGRESS');
const memo = new WeakMap<EntityInstance, Map<string, Value | typeof IN_PROGRESS>>();

function memoized(inst: EntityInstance, key: string, compute: () => Value): Value {
  let cache = memo.get(inst);
  if (!cache) memo.set(inst, (cache = new Map()));
  const hit = cache.get(key);
  if (hit === IN_PROGRESS) return undefined;
  if (hit !== undefined || cache.has(key)) return hit;
  cache.set(key, IN_PROGRESS);
  try {
    const v = compute();
    cache.set(key, v);
    return v;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

/** Resolve references in a stored attribute value against the model. */
export function resolve(model: Model | undefined, v: Value): Value {
  if (v instanceof Ref) return model?.get(v.id);
  if (v === DERIVED) return undefined;
  if (isAggregate(v)) {
    let out: Aggregate | undefined;
    for (let i = 0; i < v.length; i++) {
      const r = resolve(model, v[i]);
      if (r !== v[i] && !out) out = v.slice(0, i);
      if (out) out.push(r);
    }
    return out ?? v;
  }
  return v;
}

function applyAggregateType(schema: SchemaRuntime, type: TypeRef, value: Aggregate): Aggregate {
  const aggregate = schema.aggregateType(type);
  if (!aggregate) return value;
  if (schema.aggregateType(aggregate.of)) {
    for (const item of value) {
      if (isAggregate(item)) applyAggregateType(schema, aggregate.of, item);
    }
  }
  if (aggregate.kind === 'ARRAY' && aggregate.low !== undefined) return withLowerBound(value, aggregate.low);
  return aggregate.kind === 'SET' ? markSet(value) : value;
}

/** `base.Name`, with `name` upper-cased by the compiler. */
export function attr(base: Value, name: string, group?: string): Value {
  if (!(base instanceof EntityInstance)) return undefined;
  const slot = base.entity.slot(name, group);
  if (!slot) return undefined;
  switch (slot.k) {
    case 'explicit': {
      const raw = base.attributes[slot.index];
      const value = base.transient ? raw : resolve(base.model, raw);
      return isAggregate(value) && base.model ? applyAggregateType(base.model.schema, slot.attribute.type, value) : value;
    }
    case 'derived': {
      const fn = slot.fn;
      const model = base.model;
      if (!fn || !model) return undefined;
      return base.transient ? fn(base, model) : memoized(base, name, () => fn(base, model));
    }
    case 'inverse': {
      const model = base.model;
      if (!model || base.transient) return slot.inverse.aggregate ? [] : undefined;
      const inv = slot.inverse;
      return memoized(base, name, () => {
        const found = model.inverse(base, inv);
        if (!inv.aggregate) return found[0];
        return inv.aggregate === 'SET' ? markSet(found) : found;
      });
    }
  }
}

function unwrapAggregate(base: Value): Value {
  return base instanceof Typed ? base.value : base;
}

/** `base[i]`, honouring the aggregate's lower index bound. */
export function index(base: Value, i: Value): Value {
  const b = unwrapAggregate(base);
  const k = int(i);
  if (k === undefined) return undefined;
  if (typeof b === 'string') return k >= 1 && k <= b.length ? b[k - 1] : undefined;
  if (!isAggregate(b)) return undefined;
  return b[k - lowerBound(b)];
}

/** `base[lo:hi]` on strings and aggregates. */
export function slice(base: Value, lo: Value, hi: Value): Value {
  const b = unwrapAggregate(base);
  const l = int(lo);
  const h = int(hi);
  if (l === undefined || h === undefined) return undefined;
  if (typeof b === 'string') return b.slice(l - 1, h);
  if (!isAggregate(b)) return undefined;
  const base0 = lowerBound(b);
  return b.slice(l - base0, h - base0 + 1);
}

/**
 * A transient entity's attribute may not hold an indeterminate value unless it
 * is OPTIONAL. Failing here (as IfcOpenShell does) keeps a rule that depends on
 * such a construction from passing on missing data.
 */
function checkStored(entityName: string, name: string, optional: boolean, v: Value): void {
  const bad = v === undefined ? !optional : isAggregate(v) && v.some((x) => x === undefined);
  if (bad) throw new EvaluationError(`indeterminate value stored in ${entityName}.${name}`);
}

/** An EXPRESS entity constructor `Entity(args)`: a transient instance with the entity's own attributes set. */
export function construct(m: Model, entityName: string, args: Value[]): Value {
  const entity = m.schema.entity(entityName);
  if (!entity) throw new EvaluationError(`unknown entity ${entityName}`);
  const values: Value[] = new Array(entity.attributes.length).fill(undefined);
  let k = 0;
  for (let i = 0; i < entity.attributes.length; i++) {
    const a = entity.attributes[i];
    if (a.declaredBy !== entity.name || k >= args.length) continue;
    checkStored(entity.name, a.name, a.optional, args[k]);
    values[i] = args[k++];
  }
  return new EntityInstance(m, -1, entity, values, true);
}

/** `a || b || ...`: merge partial entity values into one complex instance of the most specific type. */
export function complex(m: Model, parts: Value[]): Value {
  const instances = parts.filter((p): p is EntityInstance => p instanceof EntityInstance);
  if (instances.length !== parts.length || instances.length === 0) return undefined;
  const leaf = instances.find((p) => instances.every((q) => p.entity.isA(q.entity.upper)));
  if (!leaf) throw new EvaluationError(`no common leaf type among ${instances.map((p) => p.entity.name).join(', ')}`);
  const values = [...leaf.attributes];
  for (const part of instances) {
    if (part === leaf) continue;
    part.entity.attributes.forEach((a, i) => {
      if (a.declaredBy === part.entity.name) values[i] = part.attributes[i];
    });
  }
  return new EntityInstance(m, -1, leaf.entity, values, true);
}

/** A defined-type constructor `IfcLabel(v)`. */
export function typed(m: Model | undefined, typeName: string, v: Value): Value {
  if (v === undefined) return undefined;
  return new Typed(m?.schema.canonicalName(typeName) ?? typeName, v instanceof Typed ? v.value : v);
}

/** Aggregates are values in EXPRESS: assignment copies them. */
export function assign(v: Value): Value {
  return isAggregate(v) ? copyAggregate(v) : v;
}

/** Assign to a variable declared SET: members become unique. */
export function assignSet(v: Value): Value {
  if (!isAggregate(v)) return v;
  return isSet(v) ? copyAggregate(v) : uniqueMembers(v);
}

/** CASE on an indeterminate selector cannot pick a branch; IfcOpenShell fails the rule there. */
export function caseSelector(v: Value): Value {
  if (v === undefined) throw new EvaluationError('CASE selector is indeterminate');
  return v;
}

/** Assign to a variable declared `ARRAY [low:...]`, so later indexing uses that base. */
export function assignArray(v: Value, low: Value): Value {
  const l = int(low);
  return isAggregate(v) && l !== undefined ? withLowerBound(copyAggregate(v), l) : assign(v);
}

export function setAttr(base: Value, name: string, v: Value): void {
  if (!(base instanceof EntityInstance)) throw new EvaluationError(`assignment to attribute ${name} of a non-entity`);
  if (!base.transient) throw new EvaluationError(`assignment to attribute ${name} of model instance ${base}`);
  const slot = base.entity.slots.get(name);
  if (slot?.k !== 'explicit') throw new EvaluationError(`assignment to non-explicit attribute ${name}`);
  checkStored(base.entity.name, slot.attribute.name, slot.attribute.optional, v);
  base.attributes[slot.index] = assign(v);
}

export function setIndex(base: Value, i: Value, v: Value): void {
  const k = int(i);
  if (!isAggregate(base) || k === undefined) throw new EvaluationError('indexed assignment outside an aggregate');
  if (v === undefined) throw new EvaluationError('indeterminate value stored in an aggregate element');
  base[k - lowerBound(base)] = assign(v);
}
