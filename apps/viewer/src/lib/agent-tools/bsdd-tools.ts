/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** bSDD lookups through the host's client (the viewer routes it through its `/api/bsdd` proxy). */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { assertToolActive } from './cancellation.js';
import { entityExists, resolveRef } from './refs.js';
import type { AgentTool, ModelFreeTool, ModelTool } from './types.js';

interface BsddHttpErrorLike {
  name: string;
  status: number;
  retryAfterSeconds?: number;
  url: string;
  statusText: string;
}

function rethrowBsdd(err: unknown, label: string): ToolExecutionError {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'BsddHttpError') {
    const e = err as BsddHttpErrorLike;
    if (e.status === 429) {
      return new ToolExecutionError({
        code: ToolErrorCode.RATE_LIMITED,
        message: `bSDD rate-limited the ${label} request (HTTP 429).`,
        details: { url: e.url, status: e.status, retryAfterSeconds: e.retryAfterSeconds },
        hint: e.retryAfterSeconds != null ? `Retry after ${e.retryAfterSeconds}s.` : 'Avoid back-to-back bSDD calls.',
      });
    }
    return new ToolExecutionError({
      code: ToolErrorCode.EXTERNAL_SERVICE_FAILED,
      message: `bSDD ${label} failed: HTTP ${e.status} ${e.statusText}.`,
      details: { url: e.url, status: e.status },
    });
  }
  if (err instanceof ToolExecutionError) return err;
  return new ToolExecutionError({
    code: ToolErrorCode.INTERNAL_ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}

const bsdd_search: ModelFreeTool = {
  needs: 'none',
  async run(host, args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`query` is required.' });
    try {
      const results = await host.bsdd.search(query);
      assertToolActive(ctx);
      const head = `bSDD search '${query}' — ${results.length} result(s)${results.length > 25 ? ', showing first 25' : ''}:`;
      const lines = results.slice(0, 25).map((r) => `• ${r.code || r.name} — ${r.name ?? ''}\n  ${r.uri}`);
      return { text: [head, ...lines].join('\n'), structured: { query, count: results.length, results: results.slice(0, 25) } };
    } catch (err) {
      throw rethrowBsdd(err, 'search');
    }
  },
};

const bsdd_class: ModelFreeTool = {
  needs: 'none',
  async run(host, args, ctx) {
    const ifcType = String(args.ifc_type ?? '');
    if (!ifcType) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`ifc_type` is required.' });
    try {
      const info = await host.bsdd.fetchClassInfo(ifcType);
      assertToolActive(ctx);
      if (!info) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `bSDD has no class for '${ifcType}'.` });
      const psetGroups = new Map<string, string[]>();
      for (const p of info.classProperties) {
        const k = p.propertySet ?? '(no Pset)';
        const list = psetGroups.get(k) ?? [];
        list.push(`${p.name}${p.dataType ? ` (${p.dataType})` : ''}`);
        psetGroups.set(k, list);
      }
      const head = `bSDD class ${info.code} — ${info.classProperties.length} properties across ${psetGroups.size} Psets:`;
      const lines: string[] = [head];
      for (const [pset, props] of psetGroups) {
        lines.push(`• ${pset} (${props.length}):`);
        for (const p of props.slice(0, 10)) lines.push(`    - ${p}`);
        if (props.length > 10) lines.push(`    - … +${props.length - 10} more`);
      }
      return { text: lines.join('\n'), structured: info as unknown as Record<string, unknown> };
    } catch (err) {
      throw rethrowBsdd(err, 'class lookup');
    }
  },
};

const bsdd_property_sets: ModelFreeTool = {
  needs: 'none',
  async run(host, args, ctx) {
    const ifcType = String(args.ifc_type ?? '');
    if (!ifcType) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`ifc_type` is required.' });
    try {
      const psets = await host.bsdd.getPropertySets(ifcType);
      assertToolActive(ctx);
      const groups = Array.from(psets.entries()).map(([name, props]) => ({ name, properties: props }));
      const head = `bSDD property sets for ${ifcType} — ${groups.length} Pset(s):`;
      const lines = [head, ...groups.map((g) => `• ${g.name} (${g.properties.length} properties)`)];
      return { text: lines.join('\n'), structured: { ifcType, propertySets: groups } };
    } catch (err) {
      throw rethrowBsdd(err, 'property-set lookup');
    }
  },
};

const bsdd_match: ModelTool = {
  needs: 'source',
  async run(host, m, args, ctx) {
    // Find related bSDD classes for an entity by IFC type. Mirrors the
    // stdio MCP path: pull the entity's IFC type, then ask bSDD for related
    // dictionary classes.
    if (typeof args.express_id !== 'number' && typeof args.global_id !== 'string') {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide express_id or global_id.' });
    }
    // The effective entity: one created this session has its class, a
    // retyped one its new class, and a deleted one is not there at all.
    const ref = resolveRef(m, args);
    const expressId = ref.expressId;
    const entity = entityExists(m, expressId) ? m.bim.entity(ref) : null;
    if (!entity) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `No entity #${expressId} in this model.` });
    }
    const ifcType = entity.type.trim();
    if (!ifcType) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Entity #${expressId} has no IFC class to match against bSDD.` });
    }
    try {
      const candidates = await host.bsdd.searchRelatedClasses(ifcType);
      assertToolActive(ctx);
      const head = `bSDD candidates for ${ifcType} (#${expressId}) — ${candidates.length} match(es):`;
      const lines = [head, ...candidates.slice(0, 10).map((c) => `• ${c.code} — ${c.name} (${c.dictionaryUri})`)];
      if (candidates.length > 10) lines.push(`  … +${candidates.length - 10} more`);
      return { text: lines.join('\n'), structured: { ifcType, expressId, candidates } };
    } catch (err) {
      throw rethrowBsdd(err, 'related-class search');
    }
  },
};

export const bsddTools: Record<string, AgentTool> = { bsdd_search, bsdd_class, bsdd_property_sets, bsdd_match };
