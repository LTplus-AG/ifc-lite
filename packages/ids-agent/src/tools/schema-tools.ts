/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema read tools (`06-ai-agent.md` §5): the model looks IFC names up
 * instead of recalling them. They read the same per-version tables the
 * grounding gate checks against (`GateContext.tables`), so a name a lookup
 * returns is a name the gate accepts.
 *
 * Results are abridged cards: short lists, capped, ranked.
 */

import type { IfcEntityInfo, IfcPropertySetInfo } from '@ifc-lite/data';
import type { VersionTables } from '@ifc-lite/ids-authoring';
import { clampLimit, objectSchema, versionSchema, type AgentToolContext, type IdsAgentTool } from './context.js';
import { defineTool, failure, success } from './registry.js';
import { rankNames } from './rank.js';

type Version = 'IFC2X3' | 'IFC4' | 'IFC4X3_ADD2';

function tables(ctx: AgentToolContext, version: Version): VersionTables {
  return ctx.gate.tables[version];
}

function chain(t: VersionTables, name: string): IfcEntityInfo[] {
  const out: IfcEntityInfo[] = [];
  const seen = new Set<string>();
  let cursor = t.entities.get(name.toUpperCase());
  while (cursor && !seen.has(cursor.name)) {
    out.push(cursor);
    seen.add(cursor.name);
    cursor = cursor.parent ? t.entities.get(cursor.parent.toUpperCase()) : undefined;
  }
  return out;
}

function applicablePsets(t: VersionTables, entity: string): IfcPropertySetInfo[] {
  const names = new Set(chain(t, entity).map((e) => e.name.toUpperCase()));
  return [...t.psets.values()].filter((p) => p.applicableEntities.some((a) => names.has(a.toUpperCase())));
}

function unknownEntity(t: VersionTables, name: string, version: Version) {
  return failure(`unknown entity ${name}`, {
    error: `"${name}" is not an entity in ${version}.`,
    candidates: rankNames(name, t.entityNames, 5),
  }, [`SCHEMA-ENT:${name}`]);
}

const searchEntities = defineTool<{ query: string; version: Version; includeAbstract?: boolean; limit?: number }, AgentToolContext>({
  name: 'schema_search_entities', group: 'schema', strict: true, readOnly: true,
  description: 'Search IFC entity (class) names of one schema version by a word or partial name. Returns ranked names with parent, abstractness and predefined types.',
  inputSchema: objectSchema({
    query: { type: 'string', minLength: 1 },
    version: versionSchema,
    includeAbstract: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, description: 'At most 25.' },
  }, ['query', 'version']),
  run(input, ctx) {
    const t = tables(ctx, input.version);
    const names = input.includeAbstract ? t.entityNames : t.entityNames.filter((n) => !t.entities.get(n.toUpperCase())?.abstract);
    const hits = rankNames(input.query, names, clampLimit(input.limit, 10, 25)).map((name) => {
      const e = t.entities.get(name.toUpperCase());
      return { name, parent: e?.parent, abstract: e?.abstract ?? false, predefinedTypes: e?.predefinedTypes.slice(0, 15) ?? [] };
    });
    return success(`${hits.length} entities for "${input.query}"`, { version: input.version, results: hits });
  },
});

const entityCard = defineTool<{ name: string; version: Version }, AgentToolContext>({
  name: 'schema_entity', group: 'schema', strict: true, readOnly: true,
  description: 'The card of one IFC entity: inheritance chain, abstractness, predefined types, attributes (inherited included), direct subtypes, type entity and applicable property sets.',
  inputSchema: objectSchema({ name: { type: 'string', minLength: 1 }, version: versionSchema }, ['name', 'version']),
  run(input, ctx) {
    const t = tables(ctx, input.version);
    const e = t.entities.get(input.name.toUpperCase());
    if (!e) return unknownEntity(t, input.name, input.version);
    const subtypes = [...t.entities.values()].filter((s) => s.parent?.toUpperCase() === e.name.toUpperCase()).map((s) => s.name);
    return success(`entity ${e.name}`, {
      version: input.version, name: e.name, abstract: e.abstract,
      inheritance: chain(t, e.name).map((c) => c.name),
      predefinedTypes: e.predefinedTypes, attributes: e.attributes,
      subtypes: subtypes.slice(0, 40), typeEntity: e.typeEntity,
      propertySets: applicablePsets(t, e.name).map((p) => p.name).slice(0, 60),
    });
  },
});

const psetsFor = defineTool<{ entity: string; version: Version; query?: string }, AgentToolContext>({
  name: 'schema_psets_for', group: 'schema', strict: true, readOnly: true,
  description: 'Standard property and quantity sets applicable to an entity (through its inheritance), with their property names. Optionally filtered by a word matched against set and property names.',
  inputSchema: objectSchema({ entity: { type: 'string', minLength: 1 }, version: versionSchema, query: { type: 'string' } }, ['entity', 'version']),
  run(input, ctx) {
    const t = tables(ctx, input.version);
    if (!t.entities.has(input.entity.toUpperCase())) return unknownEntity(t, input.entity, input.version);
    const q = input.query?.trim().toLowerCase();
    const sets = applicablePsets(t, input.entity)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.properties.some((pr) => pr.name.toLowerCase().includes(q)))
      .slice(0, 40)
      .map((p) => ({ name: p.name, properties: p.properties.map((pr) => pr.name).slice(0, 25) }));
    return success(`${sets.length} sets for ${input.entity}`, {
      version: input.version, entity: input.entity, propertySets: sets,
      ...(t.hasQuantitySets ? {} : { note: 'Quantity sets (Qto_) are not tabulated for this version and are not listed.' }),
    });
  },
});

const psetCard = defineTool<{ name: string; version: Version }, AgentToolContext>({
  name: 'schema_pset', group: 'schema', strict: true, readOnly: true,
  description: 'The properties of one standard property set: name, kind, data type and enumeration values, plus the entities it applies to.',
  inputSchema: objectSchema({ name: { type: 'string', minLength: 1 }, version: versionSchema }, ['name', 'version']),
  run(input, ctx) {
    const t = tables(ctx, input.version);
    const p = t.psets.get(input.name);
    if (!p) {
      return failure(`unknown set ${input.name}`, {
        error: `"${input.name}" is not a standard property set in ${input.version}.`,
        candidates: rankNames(input.name, t.psetNames, 5),
      }, [`SCHEMA-PSET:${input.name}`]);
    }
    return success(`set ${p.name}`, {
      version: input.version, name: p.name, applicableEntities: p.applicableEntities.slice(0, 30),
      properties: p.properties.map((pr) => ({
        name: pr.name, kind: pr.kind, ...(pr.dataType ? { dataType: pr.dataType } : {}),
        ...(pr.enumeration ? { enumeration: pr.enumeration.slice(0, 40) } : {}),
      })),
    });
  },
});

const findProperty = defineTool<{ name: string; version: Version; entity?: string }, AgentToolContext>({
  name: 'schema_find_property', group: 'schema', strict: true, readOnly: true,
  description: 'Find the standard property sets that define a property, by full or partial property name. With an entity, only sets applicable to it are returned.',
  inputSchema: objectSchema({ name: { type: 'string', minLength: 1 }, version: versionSchema, entity: { type: 'string' } }, ['name', 'version']),
  run(input, ctx) {
    const t = tables(ctx, input.version);
    const allowed = input.entity ? new Set(applicablePsets(t, input.entity).map((p) => p.name)) : null;
    const names = rankNames(input.name, [...t.psetsByProperty.keys()], 10);
    const results = names.map((property) => {
      const sets = (t.psetsByProperty.get(property) ?? []).filter((s) => !allowed || allowed.has(s));
      const dataType = sets.map((s) => t.psets.get(s)?.properties.find((pr) => pr.name === property)?.dataType).find(Boolean);
      return { property, propertySets: sets.slice(0, 15), ...(dataType ? { dataType } : {}) };
    }).filter((r) => r.propertySets.length > 0);
    return success(`${results.length} properties for "${input.name}"`, { version: input.version, results });
  },
});

export const SCHEMA_TOOLS: readonly IdsAgentTool[] = [searchEntities, entityCard, psetsFor, psetCard, findProperty];
