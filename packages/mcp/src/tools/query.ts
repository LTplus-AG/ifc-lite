/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Query tools (spec §7.2).
 *
 * Read-only entity discovery via the existing `bim` query API. We try to
 * keep the structured-content shape as close to the SDK shapes as we can,
 * because anything an agent wants to feed back into another tool comes
 * straight from these results.
 */

import { extractGeoreferencingOnDemand, extractLengthUnitScale } from '@ifc-lite/parser';
import type { ComparisonOp, EntityData, QueryFilter } from '@ifc-lite/sdk';
import type { Tool } from './types.js';
import { findByGlobalId, okResult, paginate, resolveGlobalIds, resolveModel } from './util.js';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { foldedTypeCounts, pendingMutationsField, pendingOverlay } from '../overlay.js';
import { expandTypes } from '../backend-query.js';
import { buildSpatialTree } from '../spatial-tree.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const COMPARISON_OPS: ComparisonOp[] = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'exists'];

const queryEntities: Tool = {
  name: 'query_entities',
  description: 'Filter entities by IFC type, property, material, or spatial container. Returns matching IDs and minimal metadata.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', description: 'IFC entity type, e.g. "IfcWall". Includes subtypes by default.' },
      types: { type: 'array', items: { type: 'string' }, description: 'Filter to multiple types. Combined with `type` if both supplied.' },
      property: {
        type: 'object',
        properties: {
          pset: { type: 'string' },
          name: { type: 'string' },
          op: { type: 'string', enum: COMPARISON_OPS as readonly unknown[] },
          value: {},
        },
        required: ['pset', 'name', 'op'],
        additionalProperties: false,
      },
      in_storey: { type: 'string', description: 'GlobalId of containing storey.' },
      limit: { type: 'integer', default: 1000, minimum: 1, maximum: 10000 },
      offset: { type: 'integer', default: 0, minimum: 0 },
      fields: {
        type: 'array',
        items: { type: 'string' },
        default: ['globalId', 'type', 'name'],
        description: 'Subset of EntityData fields to return. Use [] for full data.',
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const types: string[] = [];
    if (typeof input.type === 'string') types.push(input.type);
    if (Array.isArray(input.types)) for (const t of input.types as string[]) types.push(t);

    const filters: QueryFilter[] = [];
    if (input.property) {
      const p = input.property as { pset: string; name: string; op: ComparisonOp; value?: unknown };
      filters.push({ psetName: p.pset, propName: p.name, operator: p.op, value: p.value as string | number | boolean | undefined });
    }

    const limit = (input.limit as number | undefined) ?? 1000;
    const offset = (input.offset as number | undefined) ?? 0;
    // The rows themselves already fold the session's queued edits in — that
    // happens in the query backend, so the property filter above matches against
    // written values rather than parsed ones (#2004). This only reports it.
    const pending = pendingMutationsField(pendingOverlay(m));

    let results = m.bim.query()
      .byType(...types);
    if (filters.length > 0) {
      for (const f of filters) results = results.where(f.psetName, f.propName, f.operator, f.value);
    }
    if (input.in_storey) {
      // No native byStorey on QueryBuilder — filter post-hoc against containment chain.
      //
      // Through `m.bim`, never `new EntityNode(m.store, …)`: the SDK's `storey()`
      // walks the backend's `related()`, which folds the session's queued
      // relationships and drops tombstoned ones, while a raw EntityNode reads
      // the parsed graph and knows nothing about either (#2014). Reading the
      // store here dropped every entity the fold had just added to `results`,
      // which reads as a wrong storey rather than as a missing fold.
      const storeyGid = input.in_storey as string;
      const all = results.toArray();
      const matching = all.filter((entity) => {
        const storey = m.bim.storey(entity.ref);
        return storey !== null && storey.globalId === storeyGid;
      });
      const page = paginate(matching, limit, offset);
      const shaped = shapeEntities(page.items, input.fields as string[] | undefined);
      return okResult(
        formatQueryResult(page.total, page.truncated, shaped, page.items),
        { count: page.total, truncated: page.truncated, entities: shaped, ...pending },
      );
    }

    const all = results.toArray();
    const page = paginate(all, limit, offset);
    const shaped = shapeEntities(page.items, input.fields as string[] | undefined);
    return okResult(
      formatQueryResult(page.total, page.truncated, shaped, page.items),
      { count: page.total, truncated: page.truncated, entities: shaped, ...pending },
    );
  },
};

function formatQueryResult(total: number, truncated: boolean, _shaped: unknown[], items: EntityData[]): string {
  const head = `Found ${total.toLocaleString()} matching entit${total === 1 ? 'y' : 'ies'}${truncated ? ` (showing ${items.length})` : ''}.`;
  if (items.length === 0) return head;
  const lines = items.slice(0, 25).map((e) => {
    const name = e.name ? ` '${e.name}'` : '';
    const gid = e.globalId ? ` GlobalId=${e.globalId}` : '';
    return `  • ${e.type ?? '?'} #${e.ref.expressId}${name}${gid}`;
  });
  if (items.length > 25) lines.push(`  • … +${items.length - 25} more in this page`);
  return [head, ...lines].join('\n');
}

function shapeEntities(entities: EntityData[], fields?: string[]): unknown[] {
  if (!fields || fields.length === 0) {
    // Default response: surface expressId at the top level so downstream tools
    // (viewer_*, mutate_*, BCF, etc.) get a stable handle without the caller
    // having to navigate `entity.ref.expressId`.
    return entities.map((e) => ({
      expressId: e.ref.expressId,
      modelId: e.ref.modelId,
      globalId: e.globalId,
      name: e.name,
      type: e.type,
      description: e.description,
      objectType: e.objectType,
    }));
  }
  const fieldSet = new Set(fields);
  return entities.map((e) => {
    // `expressId` always, whatever `fields` asks for. It is the only handle
    // every row is guaranteed to have, and since queued entities join the result
    // set (#2014) a row can legitimately carry an empty GlobalId — the default
    // `fields` of globalId/type/name would render it unaddressable.
    const out: Record<string, unknown> = { expressId: e.ref.expressId };
    if (fieldSet.has('modelId')) out.modelId = e.ref.modelId;
    if (fieldSet.has('globalId')) out.globalId = e.globalId;
    if (fieldSet.has('name')) out.name = e.name;
    if (fieldSet.has('type')) out.type = e.type;
    if (fieldSet.has('description')) out.description = e.description;
    if (fieldSet.has('objectType')) out.objectType = e.objectType;
    return out;
  });
}

const countEntities: Tool = {
  name: 'count_entities',
  description: 'Count entities, optionally grouped by a key (type, storey, material). Returns aggregates rather than the full set.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      group_by: { type: 'string', enum: ['type', 'storey', 'material'] },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const groupBy = input.group_by as 'type' | 'storey' | 'material' | undefined;
    const typeFilter = input.type as string | undefined;
    // The type-keyed passes read `entityIndex.byType` directly rather than going
    // through `bim.query()`, so they need the fold applied here (#2004).
    const overlay = pendingOverlay(m);

    if (!groupBy) {
      const total = typeFilter
        ? m.bim.query().byType(typeFilter).toArray().length
        : [...foldedTypeCounts(m.store, overlay).values()].reduce((sum, count) => sum + count, 0);
      return okResult(
        `${total.toLocaleString()} entities${typeFilter ? ` of type ${typeFilter}` : ''}.`,
        { total, ...pendingMutationsField(overlay) },
      );
    }

    const groups = new Map<string, number>();

    if (groupBy === 'type') {
      // `type` narrows this branch too. It used to be ignored outright, so
      // `count_entities({ type: 'IfcWall', group_by: 'type' })` returned every
      // type in the model — and the filter has to expand subtypes, or asking for
      // IfcWall misses every IFCWALLSTANDARDCASE, which is what `byType('IfcWall')`
      // would have counted.
      const wanted = typeFilter ? new Set(expandTypes([typeFilter])) : null;
      for (const [type, count] of foldedTypeCounts(m.store, overlay)) {
        if (wanted && !wanted.has(type)) continue;
        // PascalCase, as `model_diff`'s type table reports it. Two tools naming
        // the same class two ways is the defect, whichever spelling is right.
        groups.set(IFC_ENTITY_NAMES[type] ?? type, count);
      }
    } else if (groupBy === 'storey') {
      const targets = typeFilter ? m.bim.query().byType(typeFilter).toArray() : m.bim.query().toArray();
      for (const e of targets) {
        // `m.bim.storey`, for the reason `in_storey` uses it: the raw EntityNode
        // walk reads the parsed graph and would file every entity this session
        // created under '(none)' even when it also queued the relationship that
        // places it.
        const storey = m.bim.storey(e.ref);
        const key = storey ? (storey.name || `Storey ${storey.ref.expressId}`) : '(none)';
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    } else if (groupBy === 'material') {
      const targets = typeFilter ? m.bim.query().byType(typeFilter).toArray() : m.bim.query().toArray();
      for (const e of targets) {
        const mat = m.bim.materials(e.ref);
        const key = mat?.name ?? '(no material)';
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    }

    const sorted = Array.from(groups.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }));

    return okResult(
      `Counted ${sorted.length} groups by ${groupBy}.`,
      {
        groupBy,
        groups: sorted,
        total: sorted.reduce((s, g) => s + g.count, 0),
        ...pendingMutationsField(overlay),
      },
    );
  },
};

const getEntity: Tool = {
  name: 'get_entity',
  description: 'Full data for a single entity: attributes, properties, quantities, classifications, materials, relationships.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer', minimum: 1 },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['attributes', 'properties', 'quantities', 'classifications', 'materials', 'documents', 'relationships', 'type_properties'] },
        default: ['attributes', 'properties', 'quantities', 'classifications', 'materials'],
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const expressId = resolveExpressId(m, input);
    const ref = { modelId: m.id, expressId };
    const data = m.bim.entity(ref);
    if (!data) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `Entity not found in model '${m.id}'`,
        details: { model_id: m.id, express_id: expressId },
      });
    }
    const include = new Set((input.include as string[] | undefined) ?? ['attributes', 'properties', 'quantities', 'classifications', 'materials']);
    const out: Record<string, unknown> = {
      ref: data.ref,
      globalId: data.globalId,
      name: data.name,
      type: data.type,
      description: data.description,
      objectType: data.objectType,
    };
    if (include.has('attributes')) out.attributes = m.bim.attributes(ref);
    if (include.has('properties')) out.properties = m.bim.properties(ref);
    if (include.has('quantities')) out.quantities = m.bim.quantities(ref);
    if (include.has('classifications')) out.classifications = m.bim.classifications(ref);
    if (include.has('materials')) out.materials = m.bim.materials(ref);
    if (include.has('documents')) out.documents = m.bim.documents(ref);
    if (include.has('relationships')) out.relationships = m.bim.relationships(ref);
    if (include.has('type_properties')) out.typeProperties = m.bim.typeProperties(ref);
    // Everything above already reflects this session's queued edits; the field
    // says the state is not on disk yet, and is absent when there is nothing
    // queued (#2004).
    Object.assign(out, pendingMutationsField(pendingOverlay(m)));
    return okResult(`${data.type} '${data.name || data.globalId}' (#${expressId})`, out);
  },
};

function resolveExpressId(m: ReturnType<typeof resolveModel>, input: Record<string, unknown>): number {
  if (typeof input.express_id === 'number') return input.express_id;
  if (typeof input.global_id === 'string') {
    const gid = input.global_id;
    const found = findByGlobalId(m, gid);
    if (found !== null) return found;
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `No entity with GlobalId '${gid}' in this model.`,
    });
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'Provide either `global_id` or `express_id`.',
  });
}

const getEntitiesBulk: Tool = {
  name: 'get_entities_bulk',
  description: 'Batch version of get_entity. Up to 1000 IDs per call. Returns a map keyed by globalId, resolved the same way '
    + '`get_entity` resolves one: an entity this session created wins over a same-GlobalId entity in the file, and deleted '
    + 'entities are never returned. A GlobalId naming more than one entity is listed in `ambiguousGlobalIds`.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_ids: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
      express_ids: { type: 'array', items: { type: 'integer' }, maxItems: 1000 },
      include: {
        type: 'array',
        items: { type: 'string' },
        default: ['attributes'],
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const include = new Set((input.include as string[] | undefined) ?? ['attributes']);
    // Reject oversized requests up front, before materializing the id list or
    // scanning the byType store for global_ids.
    const requestedCount =
      (Array.isArray(input.express_ids) ? input.express_ids.length : 0) +
      (Array.isArray(input.global_ids) ? input.global_ids.length : 0);
    if (requestedCount > 1000) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'Bulk call exceeds 1000 IDs.',
        hint: 'Page using `query_entities` with offset.',
      });
    }
    // Requested GlobalIds are resolved through the shared rule — queued entities
    // first, tombstoned ones never — so `entities[gid]` is the same entity
    // `get_entity(global_id: gid)` returns (#2015). It used to be whichever id
    // this loop happened to visit last, which is the parsed store's, so bulk and
    // single readback disagreed after a session duplicate.
    const carriers = Array.isArray(input.global_ids)
      ? resolveGlobalIds(m, input.global_ids as string[])
      : new Map<string, number[]>();

    const ids: number[] = [];
    const seenIds = new Set<number>();
    const pushId = (id: number): void => {
      if (seenIds.has(id)) return;
      seenIds.add(id);
      ids.push(id);
    };
    // GlobalId winners first: the map is keyed by GlobalId, so the value under a
    // key has to be the entity that key resolves to, even when the caller also
    // named a different entity by express id that happens to share it. The
    // displaced one is reported below rather than dropped in silence.
    for (const [, list] of carriers) pushId(list[0]);
    if (Array.isArray(input.express_ids)) for (const id of input.express_ids as number[]) pushId(id);

    if (ids.length > 1000) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'Bulk call exceeds 1000 entities.',
        hint: 'Page using `query_entities` with offset.',
      });
    }

    const entities: Record<string, unknown> = {};
    // Every live entity this call saw per GlobalId, so a key that names more
    // than one can be reported instead of quietly resolved.
    const byGlobalId = new Map<string, number[]>(
      [...carriers].map(([globalId, list]) => [globalId, [...list]]),
    );
    for (const id of ids) {
      const ref = { modelId: m.id, expressId: id };
      const data = m.bim.entity(ref);
      if (!data) continue;
      // The map is keyed by GlobalId, so an entity without one has no key here.
      // Queued entities can lack one (#2014); keying them all on '' would let
      // one silently overwrite the rest. `get_entity(express_id)` reaches them.
      if (!data.globalId) continue;
      const known = byGlobalId.get(data.globalId);
      if (!known) byGlobalId.set(data.globalId, [id]);
      else if (!known.includes(id)) known.push(id);
      // First write wins, and the first write is the resolved one.
      if (Object.prototype.hasOwnProperty.call(entities, data.globalId)) continue;
      const e: Record<string, unknown> = { ...data };
      if (include.has('properties')) e.properties = m.bim.properties(ref);
      if (include.has('quantities')) e.quantities = m.bim.quantities(ref);
      if (include.has('classifications')) e.classifications = m.bim.classifications(ref);
      if (include.has('materials')) e.materials = m.bim.materials(ref);
      entities[data.globalId] = e;
    }

    // A GlobalId is supposed to be unique and in practice is not. Returning one
    // of two without saying so is how this stayed hidden, and it is the same
    // refusal-to-guess `model_diff` makes when it reports `duplicated` groups
    // rather than pairing them.
    const ambiguous = [...byGlobalId]
      .filter(([globalId, list]) => list.length > 1 && globalId in entities)
      .map(([globalId, list]) => ({
        globalId,
        expressIds: list,
        returned: (entities[globalId] as { ref: { expressId: number } }).ref.expressId,
      }));

    const summary = `Resolved ${Object.keys(entities).length} entities.`
      + (ambiguous.length > 0 ? ` ${ambiguous.length} GlobalId(s) name more than one entity.` : '');
    return okResult(summary, {
      entities,
      ...(ambiguous.length > 0 ? { ambiguousGlobalIds: ambiguous } : {}),
      ...pendingMutationsField(pendingOverlay(m)),
    });
  },
};

const spatialHierarchy: Tool = {
  name: 'spatial_hierarchy',
  description: 'Project → Site → Building → Storey → Space tree. Compact form by default (set `include_elements` to expand).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      include_elements: { type: 'boolean', default: false, description: 'Include expressIds of contained elements per spatial node.' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const includeElements = (input.include_elements as boolean | undefined) ?? false;
    // One walk, shared with the `…/spatial-tree` resource (`spatial-tree.ts`):
    // aggregation-only children, a visited set so a cyclic file cannot hang the
    // server, and one rule for which IfcProject the tree hangs from.
    const tree = buildSpatialTree(m, { includeElements });
    return okResult(`Spatial hierarchy for '${m.name}'.`, { tree, ...pendingMutationsField(pendingOverlay(m)) });
  },
};

const containmentChain: Tool = {
  name: 'containment_chain',
  description: 'For an entity, return its spatial containment chain from the entity up to the project root.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const expressId = resolveExpressId(m, input);
    const ref = { modelId: m.id, expressId };
    const path = m.bim.path(ref);
    return okResult(`${path.length}-step containment path.`, {
      path: path.map((p) => ({ expressId: p.ref.expressId, globalId: p.globalId, type: p.type, name: p.name })),
      ...pendingMutationsField(pendingOverlay(m)),
    });
  },
};

const relationships: Tool = {
  name: 'relationships',
  description: 'Inbound and outbound relationships of an entity (voids, fills, groups, connections, …).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string' },
      express_id: { type: 'integer' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const expressId = resolveExpressId(m, input);
    return okResult('Relationships', m.bim.relationships({ modelId: m.id, expressId }) as unknown as Record<string, unknown>);
  },
};

const propertiesUnique: Tool = {
  name: 'properties_unique',
  description: 'Unique values for a single property across a type set. Useful for filter UIs and stats.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string' },
      pset: { type: 'string' },
      property: { type: 'string' },
    },
    required: ['type', 'pset', 'property'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const type = input.type as string;
    const psetName = input.pset as string;
    const propName = input.property as string;
    const counts = new Map<string, number>();
    let total = 0;
    for (const e of m.bim.query().byType(type).toArray()) {
      const v = m.bim.property(e.ref, psetName, propName);
      const key = v == null ? '(missing)' : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    const values = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    // Rich text content so MCP clients that only forward content[].text to the
    // model still get the actual histogram, not just the count.
    const head = `${values.length} unique value(s) for ${type}.${psetName}.${propName} across ${total} entit${total === 1 ? 'y' : 'ies'}:`;
    const lines = values.slice(0, 50).map((v) => `  • ${v.value} — ${v.count}`);
    if (values.length > 50) lines.push(`  • … +${values.length - 50} more`);
    return okResult([head, ...lines].join('\n'), { values, total, ...pendingMutationsField(pendingOverlay(m)) });
  },
};

const materialsList: Tool = {
  name: 'materials_list',
  description: 'All materials present in the model with usage counts.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { model_id: { type: 'string' } },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const counts = new Map<string, number>();
    for (const e of m.bim.query().toArray()) {
      const mat = m.bim.materials(e.ref);
      if (!mat) continue;
      const key = mat.name ?? '(unnamed)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    const head = `${list.length} distinct material(s) in use:`;
    const lines = list.slice(0, 50).map((m) => `  • ${m.name} — ${m.count}`);
    if (list.length > 50) lines.push(`  • … +${list.length - 50} more`);
    return okResult([head, ...lines].join('\n'), { materials: list, ...pendingMutationsField(pendingOverlay(m)) });
  },
};

const classificationsList: Tool = {
  name: 'classifications_list',
  description: 'All classification references in the model with usage counts.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { model_id: { type: 'string' } },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const counts = new Map<string, number>();
    for (const e of m.bim.query().toArray()) {
      for (const c of m.bim.classifications(e.ref)) {
        const key = `${c.system ?? '?'}:${c.identification ?? c.name ?? '?'}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
    const head = `${list.length} distinct classification reference(s):`;
    const lines = list.slice(0, 50).map((c) => `  • ${c.key} — ${c.count}`);
    if (list.length > 50) lines.push(`  • … +${list.length - 50} more`);
    return okResult([head, ...lines].join('\n'), { classifications: list, ...pendingMutationsField(pendingOverlay(m)) });
  },
};

const georeferencing: Tool = {
  name: 'georeferencing',
  description: 'Coordinate reference system, MapConversion, project north and true north.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    return okResult('Georeferencing', { georeferencing: extractGeoreferencingOnDemand(m.store) ?? null });
  },
};

const units: Tool = {
  name: 'units',
  description: 'Length unit scale (factor that converts stored lengths to meters) and other unit metadata.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const scale = m.store.source && m.store.entityIndex
      ? extractLengthUnitScale(m.store.source, m.store.entityIndex)
      : 1.0;
    return okResult(`Length unit scale: ${scale} (lengths × ${scale} → meters).`, { lengthUnitScale: scale });
  },
};

export const queryTools: Tool[] = [
  queryEntities,
  countEntities,
  getEntity,
  getEntitiesBulk,
  spatialHierarchy,
  containmentChain,
  relationships,
  propertiesUnique,
  materialsList,
  classificationsList,
  georeferencing,
  units,
];
