/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** How many WHERE rules of a schema, and of the authoring subset, were compiled. */

import type { SchemaRuntime } from '../src/index.js';
import type { TypeRef } from '../src/runtime/schema-meta.js';

export interface RuleCoverage {
  schema: string;
  scope: 'all' | 'authoring';
  entityWhere: { total: number; compiled: number };
  typeWhere: { total: number; compiled: number };
  global: { total: number; compiled: number };
  compiledPercent: number;
  unsupported: string[];
}

function count(schema: SchemaRuntime, entities: Set<string>, types: Set<string>, scope: RuleCoverage['scope']): RuleCoverage {
  const { rules } = schema;
  const unsupported = rules.unsupported.filter((u) =>
    (u.scope === 'entity' && entities.has(u.owner)) || (u.scope === 'type' && types.has(u.owner)) || u.scope === 'global');
  const compiledEntity = [...entities].reduce((n, e) => n + (rules.entity[e]?.length ?? 0), 0);
  const compiledType = [...types].reduce((n, t) => n + (rules.type[t]?.length ?? 0), 0);
  const compiledGlobal = rules.global.reduce((n, g) => n + g.rules.length, 0);
  const missing = (s: string) => unsupported.filter((u) => u.scope === s).length;
  const entityWhere = { total: compiledEntity + missing('entity'), compiled: compiledEntity };
  const typeWhere = { total: compiledType + missing('type'), compiled: compiledType };
  const global = { total: compiledGlobal + missing('global'), compiled: compiledGlobal };
  const total = entityWhere.total + typeWhere.total + global.total;
  const compiled = entityWhere.compiled + typeWhere.compiled + global.compiled;
  return {
    schema: schema.name, scope, entityWhere, typeWhere, global,
    compiledPercent: total ? Math.round((compiled / total) * 10000) / 100 : 100,
    unsupported: unsupported.map((u) => `${u.owner}.${u.label}: ${u.reason}`),
  };
}

export function schemaCoverage(schema: SchemaRuntime): RuleCoverage {
  return count(schema, new Set(schema.meta.entities.map((e) => e.name)), new Set(schema.meta.types.map((t) => t.name)), 'all');
}

export function authoringCoverage(schema: SchemaRuntime, subset: string[]): RuleCoverage {
  const entities = new Set<string>();
  const types = new Set<string>();
  const visitType = (t: TypeRef) => {
    if (t.k === 'aggregate') return visitType(t.of);
    if (t.k !== 'named') return;
    const decl = schema.type(t.name);
    if (!decl || types.has(decl.name)) return;
    types.add(decl.name);
    if (decl.kind === 'defined') visitType(decl.underlying);
    if (decl.kind === 'select') for (const item of decl.items) visitType({ k: 'named', name: item });
  };
  for (const name of subset) {
    const e = schema.entity(name);
    if (!e) continue;
    for (const level of e.chain) entities.add(level.name);
    for (const a of e.attributes) visitType(a.type);
  }
  return count(schema, entities, types, 'authoring');
}
