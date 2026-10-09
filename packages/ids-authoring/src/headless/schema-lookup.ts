/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grounding lookups over the gate's schema tables, for agents that author
 * IDS (MCP `ids_schema_search` / `ids_schema_entity` / `ids_schema_pset`).
 * An agent that looks a name up here and then uses it passes the gate,
 * because both read the same tables.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import { inheritanceChain, type GateContext, type VersionTables } from '../gate/context.js';
import { rankCandidates } from '../gate/rank.js';

export type SchemaKind = 'entity' | 'pset' | 'property' | 'dataType';

export interface SchemaHit {
  kind: SchemaKind;
  value: string;
  /** 0..1, higher is better. */
  score: number;
  reason?: string;
}

export interface SchemaSearchOptions {
  /** Restrict to one kind (default: all). */
  kind?: SchemaKind;
  /** Schema version (default IFC4). */
  version?: IFCVersion;
  limit?: number;
}

const MAX_SETS_IN_REASON = 3;

function pools(t: VersionTables): Record<SchemaKind, readonly string[]> {
  return {
    entity: t.entityNames,
    pset: t.psetNames,
    property: [...t.psetsByProperty.keys()],
    dataType: [...t.dataTypes.values()].map((d) => d.name),
  };
}

function propertyReason(t: VersionTables, name: string): string | undefined {
  const sets = t.psetsByProperty.get(name);
  if (!sets?.length) return undefined;
  const more = sets.length > MAX_SETS_IN_REASON ? ` and ${sets.length - MAX_SETS_IN_REASON} more` : '';
  return `in ${sets.slice(0, MAX_SETS_IN_REASON).join(', ')}${more}`;
}

/** Rank schema names close to `query`, best first. */
export function searchSchema(ctx: GateContext, query: string, options: SchemaSearchOptions = {}): SchemaHit[] {
  const t = ctx.tables[options.version ?? 'IFC4'];
  const limit = options.limit ?? 10;
  const all = pools(t);
  const kinds: SchemaKind[] = options.kind ? [options.kind] : ['entity', 'pset', 'property', 'dataType'];
  const hits: SchemaHit[] = [];
  for (const kind of kinds) {
    for (const c of rankCandidates(query, all[kind], { limit })) {
      const reason = kind === 'property' ? propertyReason(t, c.value) : undefined;
      hits.push(reason ? { kind, value: c.value, score: c.score, reason } : { kind, value: c.value, score: c.score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  return hits.slice(0, limit);
}

export interface EntityDescription {
  name: string;
  version: IFCVersion;
  abstract: boolean;
  /** Supertypes, nearest first. */
  ancestors: string[];
  predefinedTypes: string[];
  attributes: string[];
  /** Standard property and quantity sets applicable to the entity or a supertype. */
  propertySets: string[];
}

/** The entity as the gate sees it, or `undefined` when the name is not an entity of `version`. */
export function describeEntity(ctx: GateContext, name: string, version: IFCVersion = 'IFC4'): EntityDescription | undefined {
  const t = ctx.tables[version];
  const chain = inheritanceChain(t, name);
  if (chain.length === 0) return undefined;
  const [self, ...ancestors] = chain;
  const names = new Set(chain.map((e) => e.name.toUpperCase()));
  const propertySets = [...t.psets.values()]
    .filter((p) => p.applicableEntities.some((a) => names.has(a.toUpperCase())))
    .map((p) => p.name)
    .sort();
  return {
    name: self.name,
    version,
    abstract: self.abstract,
    ancestors: ancestors.map((e) => e.name),
    predefinedTypes: [...self.predefinedTypes],
    attributes: [...self.attributes],
    propertySets,
  };
}

export interface PsetDescription {
  name: string;
  version: IFCVersion;
  applicableEntities: string[];
  properties: { name: string; kind: string; dataType?: string; enumeration?: string[] }[];
}

/** The standard property or quantity set, or `undefined` when `version` has none of that name. */
export function describePset(ctx: GateContext, name: string, version: IFCVersion = 'IFC4'): PsetDescription | undefined {
  const pset = ctx.tables[version].psets.get(name);
  if (!pset) return undefined;
  return {
    name: pset.name,
    version,
    applicableEntities: [...pset.applicableEntities],
    properties: pset.properties.map((p) => ({
      name: p.name,
      kind: p.kind,
      ...(p.dataType ? { dataType: p.dataType } : {}),
      ...(p.enumeration ? { enumeration: [...p.enumeration] } : {}),
    })),
  };
}
