/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discovery, query and audit tools over one model, shared by every agent
 * tool host (#9523). Each reads through `model.bim` and the model's pending
 * overlay, and every entity query is pinned to `model.id`.
 */

import { ToolErrorCode, ToolExecutionError, firstNonBlank } from '@ifc-lite/mcp/browser';
import { lensMaterialNames } from '@ifc-lite/rules';
import { createGlobalIdResolver, effectiveEntities, effectiveEntityCount, effectiveTypeCounts } from './effective.js';
import { formatBytes, integerArg, modelQuery, refStr, resolveRef } from './refs.js';
import { containmentChain, spatialHierarchy } from './spatial.js';
import type { AgentTool, ModelHandle, ReadyModel } from './types.js';

function isReady(model: ModelHandle): model is ReadyModel {
  return model.store !== null;
}

/**
 * One `model_list` row. A model that cannot answer every tool also says why,
 * and a layer of a composition counts nothing of its own: the composition is
 * counted once, under the model that owns it.
 */
function modelListRow(model: ModelHandle) {
  const counted = isReady(model) && model.status !== 'composed-layer'
    ? { entityCount: effectiveEntityCount(model) as number | null, schema: model.store.schemaVersion as string | null }
    : { entityCount: null, schema: null };
  const row = { id: model.id, name: model.name, ...counted };
  if (model.status === 'ready') return row;
  return { ...row, status: model.status, ...(model.composedInto ? { composedInto: model.composedInto } : {}) };
}

function describeListRow(row: ReturnType<typeof modelListRow>): string {
  const count = row.entityCount === null ? null : `${row.entityCount.toLocaleString()} entities`;
  const status = 'status' in row ? row.status : null;
  const owner = 'composedInto' in row && row.composedInto ? `of '${row.composedInto}'` : null;
  return `${row.name} (${[count, status, owner].filter(Boolean).join(', ')})`;
}

/** Most entities `query_entities` returns in one page. */
const QUERY_LIMIT_MAX = 200;
/** Most GlobalIds `get_entities_bulk` looks up in one call. */
const BULK_CAP = 200;

export const readTools: Record<string, AgentTool> = {
  // ── Discovery ───────────────────────────────────────────────────────────
  model_info: {
    needs: 'store',
    async run(_host, m) {
      const typeCounts = effectiveTypeCounts(m);
      const count = [...typeCounts.values()].reduce((total, n) => total + n, 0);
      const top = [...typeCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([type, count]) => ({ type, count }));
      const summary = `Model '${m.name}' (${m.store.schemaVersion}): ${count.toLocaleString()} entities, ${formatBytes(m.fileSize)}`;
      return {
        text: summary,
        structured: {
          id: m.id,
          name: m.name,
          schema: m.store.schemaVersion,
          entityCount: count,
          fileSize: m.fileSize,
          typeCountsTop20: top,
        },
      };
    },
  },

  model_list: {
    needs: 'none',
    async run(host) {
      const rows = host.models().map(modelListRow);
      const text = rows.length === 0
        ? 'No model loaded.'
        : rows.length === 1
          ? `1 model loaded: ${describeListRow(rows[0])}.`
          : `${rows.length} models loaded: ${rows.map(describeListRow).join(', ')}.`;
      return { text, structured: { models: rows } };
    },
  },

  schema_describe: {
    needs: 'none',
    async run(_host, args) {
      const type = String(args.type ?? '');
      if (!type) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`type` is required.' });
      }
      return {
        text: `Schema description for ${type} is best read from /mcp#schema_describe — the full reflection table requires the @ifc-lite/data introspection map (server-side only in v1).`,
        structured: { type, note: 'In-browser schema reflection is in v0.3.' },
      };
    },
  },

  // ── Query ───────────────────────────────────────────────────────────────
  query_entities: {
    needs: 'source',
    async run(_host, m, args) {
      const type = args.type as string | undefined;
      const limit = integerArg(args.limit, { min: 0, max: QUERY_LIMIT_MAX, fallback: 50 });
      const offset = integerArg(args.offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      let q = modelQuery(m);
      if (type) q = q.byType(type);
      const all = q.toArray();
      const page = all.slice(offset, offset + limit);
      const head = `Found ${all.length.toLocaleString()} matching entit${all.length === 1 ? 'y' : 'ies'}${page.length < all.length ? ` (showing ${page.length})` : ''}.`;
      const lines = page.slice(0, 25).map((e) => {
        const name = e.name ? ` '${e.name}'` : '';
        const gid = e.globalId ? ` GlobalId=${e.globalId}` : '';
        return `  • ${e.type ?? '?'} #${e.ref.expressId}${name}${gid}`;
      });
      return {
        text: [head, ...lines].join('\n'),
        structured: {
          count: all.length,
          truncated: page.length < all.length,
          entities: page.map((e) => ({
            expressId: e.ref.expressId,
            modelId: e.ref.modelId,
            globalId: e.globalId,
            name: e.name,
            type: e.type,
            description: e.description,
            objectType: e.objectType,
          })),
        },
      };
    },
  },

  count_entities: {
    needs: 'source',
    async run(_host, m, args) {
      const groupBy = (args.group_by as string | undefined) ?? 'type';
      const typeFilter = args.type as string | undefined; // narrows the universe first, like the Node MCP server
      const universe = () => (typeFilter ? modelQuery(m).byType(typeFilter) : modelQuery(m)).toArray();
      const counts = new Map<string, number>();
      if (groupBy === 'type') {
        // BIM products only (#3765): `entityIndex.byType` is every raw STEP record.
        for (const e of universe()) {
          const key = e.type || '(unknown)';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      } else if (groupBy === 'storey') {
        for (const e of universe()) {
          const storey = m.bim.storey(e.ref);
          const key = firstNonBlank(storey?.name) ?? '(no storey)';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      } else if (groupBy === 'material') {
        for (const e of universe()) {
          const mat = m.bim.materials(e.ref);
          const key = lensMaterialNames(mat)[0] ?? '(no material)';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const groups = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ key, count }));
      return {
        text: `Counted ${groups.length} group(s) by ${groupBy}.\n${groups.slice(0, 25).map((g) => `  • ${g.key} — ${g.count}`).join('\n')}`,
        structured: { groupBy, groups },
      };
    },
  },

  get_entity: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const data = m.bim.entity(ref);
      if (!data) {
        throw new ToolExecutionError({
          code: ToolErrorCode.ENTITY_NOT_FOUND,
          message: `No entity at ${refStr(ref)} in this model.`,
        });
      }
      return {
        text: `${data.type} '${firstNonBlank(data.name) ?? '(unnamed)'}' (#${data.ref.expressId})`,
        structured: data,
      };
    },
  },

  get_entities_bulk: {
    needs: 'source',
    async run(_host, m, args) {
      if (args.global_ids !== undefined && !Array.isArray(args.global_ids)) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`global_ids` must be an array of GlobalId strings.' });
      }
      const gids = (args.global_ids as unknown[] | undefined) ?? [];
      // One entry per considered input position, so entries line up with the
      // request; a repeated GlobalId resolves (to the same entity) each time.
      const considered = gids.slice(0, BULK_CAP);
      const out: unknown[] = [];
      const lookup = createGlobalIdResolver(m);
      for (const gid of considered) {
        if (typeof gid !== 'string') { out.push(null); continue; }
        try {
          const ref = resolveRef(m, { global_id: gid }, lookup);
          out.push(m.bim.entity(ref));
        } catch {
          // An unresolvable GlobalId is reported in place as null, not as a failed call.
          out.push(null);
        }
      }
      const resolved = out.filter(Boolean).length;
      if (gids.length <= BULK_CAP) {
        return { text: `Resolved ${resolved}/${gids.length} entities.`, structured: { entities: out } };
      }
      // Ids past the cap were not looked up, so they are reported as skipped, never as unresolved.
      return {
        text: `Resolved ${resolved}/${considered.length} entities; only the first ${BULK_CAP} of ${gids.length} GlobalIds were looked up (${gids.length - BULK_CAP} skipped). Call again with the rest.`,
        structured: { entities: out, requested: gids.length, considered: considered.length, resolved, truncated: true, cap: BULK_CAP },
      };
    },
  },

  spatial_hierarchy: {
    needs: 'source',
    async run(_host, m) {
      const hierarchy = spatialHierarchy(m);
      return {
        text: `Spatial hierarchy for '${m.name}'${hierarchy.truncated ? ' (truncated)' : ''}.`,
        structured: hierarchy,
      };
    },
  },

  containment_chain: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const chain = containmentChain(m, ref);
      return { text: `${chain.path.length}-step containment path${chain.truncated ? ' (truncated)' : ''}.`, structured: chain };
    },
  },

  relationships: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const data = m.bim.relationships(ref);
      return { text: `Relationships`, structured: data };
    },
  },

  properties_unique: {
    needs: 'source',
    async run(_host, m, args) {
      const type = String(args.type ?? '');
      const psetName = String(args.pset ?? '');
      const propName = String(args.property ?? '');
      if (!type || !psetName || !propName) {
        throw new ToolExecutionError({
          code: ToolErrorCode.INVALID_INPUT,
          message: 'type, pset and property are all required.',
        });
      }
      const counts = new Map<string, number>();
      let total = 0;
      for (const e of modelQuery(m).byType(type).toArray()) {
        const v = m.bim.property(e.ref, psetName, propName);
        const key = v == null ? '(missing)' : String(v);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total++;
      }
      const values = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
      const head = `${values.length} unique value(s) for ${type}.${psetName}.${propName} across ${total} entit${total === 1 ? 'y' : 'ies'}:`;
      return { text: [head, ...values.slice(0, 30).map((v) => `  • ${v.value} — ${v.count}`)].join('\n'), structured: { values, total } };
    },
  },

  materials_list: {
    needs: 'source',
    async run(_host, m) {
      const counts = new Map<string, number>();
      for (const e of modelQuery(m).toArray()) {
        const mat = m.bim.materials(e.ref);
        if (!mat) continue;
        const key = lensMaterialNames(mat)[0] ?? '(unnamed)';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
      return {
        text: `${list.length} distinct material(s) in use:\n${list.slice(0, 30).map((row) => `  • ${row.name} — ${row.count}`).join('\n')}`,
        structured: { materials: list },
      };
    },
  },

  classifications_list: {
    needs: 'source',
    async run(_host, m) {
      const counts = new Map<string, number>();
      for (const e of modelQuery(m).toArray()) {
        for (const c of m.bim.classifications(e.ref)) {
          const key = `${c.system ?? '?'}:${c.identification ?? c.name ?? '?'}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const list = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
      return {
        text: `${list.length} distinct classification reference(s):\n${list.slice(0, 30).map((c) => `  • ${c.key} — ${c.count}`).join('\n')}`,
        structured: { classifications: list },
      };
    },
  },

  georeferencing: {
    needs: 'source',
    async run(_host, m) {
      const counts = [...effectiveEntities(m, ['IFCMAPCONVERSION'])];
      return {
        text: counts.length === 0 ? 'Model has no IfcMapConversion (no georeferencing).' : `${counts.length} IfcMapConversion entity (georeferenced).`,
        structured: { hasGeoreference: counts.length > 0 },
      };
    },
  },

  // ── Validation ──────────────────────────────────────────────────────────
  model_audit: {
    needs: 'source',
    async run(_host, m) {
      const products = modelQuery(m).toArray();
      let missingGid = 0, missingName = 0;
      for (const e of products) {
        if (!e.globalId) missingGid++;
        if (!e.name) missingName++;
      }
      const issues = missingGid + (missingName > products.length / 2 ? 1 : 0);
      const score = Math.max(0, 100 - issues * 5);
      return {
        text: `Audit score: ${score}/100${issues > 0 ? ` (${issues} issue${issues === 1 ? '' : 's'}).` : '. Clean.'}`,
        structured: { overall: score, issues: { missingGlobalIds: missingGid, missingNamesRatio: missingName / Math.max(1, products.length) } },
      };
    },
  },
};
