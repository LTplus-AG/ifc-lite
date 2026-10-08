/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared helpers for catalogue rules: schema lookups and gated fixes. */

import type { IfcEntityInfo } from '@ifc-lite/data';
import type { IDSConstraint, IDSEntityFacet, IFCVersion } from '@ifc-lite/ids';
import type { StudioDocument } from '../../document/types.js';
import { checkOps } from '../../gate/check.js';
import { inheritanceChain, type VersionTables } from '../../gate/context.js';
import { literals } from '../../gate/grounding.js';
import type { FacetView, LintContext, QuickFix, SpecView } from '../types.js';

export { literals, single } from '../../gate/grounding.js';

export function tables(ctx: LintContext, version: IFCVersion): VersionTables {
  return ctx.gate.tables[version];
}

/** Keep only fixes that pass the grounding gate on `doc`. */
export function gated(doc: StudioDocument, ctx: LintContext, fixes: readonly (QuickFix | undefined)[]): QuickFix[] | undefined {
  const ok = fixes.filter((f): f is QuickFix => !!f && f.ops.length > 0 && checkOps(f.ops, doc, ctx.gate).ok);
  return ok.length ? ok : undefined;
}

const CHILDREN = new WeakMap<VersionTables, Map<string, IfcEntityInfo[]>>();

function childrenIndex(t: VersionTables): Map<string, IfcEntityInfo[]> {
  let map = CHILDREN.get(t);
  if (!map) {
    map = new Map();
    for (const e of t.entities.values()) {
      if (!e.parent) continue;
      const key = e.parent.toUpperCase();
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    CHILDREN.set(t, map);
  }
  return map;
}

/** Every descendant of `name` (not itself), breadth first. Iterative: no recursion over table data. */
export function descendants(t: VersionTables, name: string): IfcEntityInfo[] {
  const index = childrenIndex(t);
  const out: IfcEntityInfo[] = [];
  const seen = new Set<string>([name.toUpperCase()]);
  const queue = [name.toUpperCase()];
  while (queue.length) {
    const next = queue.shift() as string;
    for (const child of index.get(next) ?? []) {
      const key = child.name.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(child);
      queue.push(key);
    }
  }
  return out;
}

export function isSubtypeOf(t: VersionTables, name: string, ancestor: string): boolean {
  const target = ancestor.toUpperCase();
  return inheritanceChain(t, name).some((e) => e.name.toUpperCase() === target);
}

/**
 * Concrete descendants of `name` that exist and are concrete in EVERY
 * version, as PascalCase names in the order of the first version.
 */
export function concreteDescendants(ctx: LintContext, versions: readonly IFCVersion[], name: string): string[] {
  if (!versions.length) return [];
  const [first, ...rest] = versions;
  return descendants(tables(ctx, first), name)
    .filter((e) => !e.abstract)
    .filter((e) => rest.every((v) => tables(ctx, v).entities.get(e.name.toUpperCase())?.abstract === false))
    .map((e) => e.name);
}

/** Canonical PascalCase name of an entity literal, from the first version that knows it. */
export function canonicalEntity(ctx: LintContext, versions: readonly IFCVersion[], name: string): string | undefined {
  for (const v of versions) {
    const e = tables(ctx, v).entities.get(name.toUpperCase());
    if (e) return e.name;
  }
  return undefined;
}

/** Literal entity names (upper case) of the spec's applicability entity facets. */
export function applicabilityEntityNames(spec: SpecView): string[] {
  return spec.applicability.flatMap((f) => (f.facet.type === 'entity' ? literals(f.facet.name).map((n) => n.toUpperCase()) : []));
}

/** The single applicability entity facet, when there is exactly one. */
export function soleEntityFacet(spec: SpecView): IDSEntityFacet | undefined {
  const facets = spec.applicability.filter((f) => f.facet.type === 'entity');
  const only = facets.length === 1 ? facets[0].facet : undefined;
  return only?.type === 'entity' ? only : undefined;
}

/** Facets carrying an entity name: entity facets and partOf related entities. */
export function entityNameSites(spec: SpecView): { view: FacetView; field: 'entity.name' | 'partOf.entity.name'; constraint: IDSConstraint; pdt?: IDSConstraint }[] {
  const out: ReturnType<typeof entityNameSites> = [];
  for (const view of [...spec.applicability, ...spec.requirements]) {
    const f = view.facet;
    if (f.type === 'entity') out.push({ view, field: 'entity.name', constraint: f.name, pdt: f.predefinedType });
    if (f.type === 'partOf' && f.entity) out.push({ view, field: 'partOf.entity.name', constraint: f.entity.name, pdt: f.entity.predefinedType });
  }
  return out;
}

/** Replace `value` by `replacement` (in place) in the literal list of `c`. */
export function replaceLiteral(c: IDSConstraint, value: string, replacement: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of literals(c)) {
    for (const r of v === value ? replacement : [v]) if (!out.some((o) => o.toUpperCase() === r.toUpperCase())) out.push(r);
  }
  return out;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Up to `n` items, then "…and k more". */
export function listSome(items: readonly string[], n = 5): string {
  return items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} and ${items.length - n} more`;
}
