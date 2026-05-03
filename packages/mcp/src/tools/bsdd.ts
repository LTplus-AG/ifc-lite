/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD tools (spec §7.7) — wrap `bim.bsdd.*` so an agent can resolve
 * canonical buildingSMART class & property metadata from a chat without
 * making raw HTTP calls.
 */

import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { BsddHttpError, type BsddSearchResult, type BsddClassInfo, type BsddClassProperty } from '@ifc-lite/sdk';

/**
 * Translate a thrown bSDD client error into a typed ToolExecutionError so the
 * agent gets a stable code (RATE_LIMITED vs EXTERNAL_SERVICE_FAILED) plus a
 * `Retry-After` hint when the upstream API supplied one.
 */
function rethrowBsddError(err: unknown, label: string): never {
  if (err instanceof BsddHttpError) {
    if (err.status === 429) {
      const retry = err.retryAfterSeconds;
      throw new ToolExecutionError({
        code: ToolErrorCode.RATE_LIMITED,
        message: `bSDD rate-limited the ${label} request (HTTP 429).`,
        details: { url: err.url, status: err.status, retryAfterSeconds: retry },
        hint: retry != null
          ? `Retry after ${retry}s. Avoid running large search queries back-to-back with class lookups.`
          : 'Avoid running large search queries back-to-back with class lookups.',
      });
    }
    throw new ToolExecutionError({
      code: ToolErrorCode.EXTERNAL_SERVICE_FAILED,
      message: `bSDD ${label} failed: HTTP ${err.status} ${err.statusText}.`,
      details: { url: err.url, status: err.status },
    });
  }
  throw err;
}

// ── text-summary helpers ─────────────────────────────────────────────────
//
// Critical: most MCP clients (Claude Desktop included) only forward the
// `content[].text` field of a tool result to the model. If we leave that as
// "Found 23 results." the LLM literally cannot see the bSDD payload, even
// though `structuredContent` carries it. Build rich human-readable summaries
// here so the data survives the trip into the model's context.

function summarizeSearchResults(query: string, results: BsddSearchResult[], limit = 25): string {
  if (results.length === 0) return `No bSDD classes match '${query}'.`;
  const head = `bSDD search '${query}' — ${results.length} result(s)${results.length > limit ? `, showing first ${limit}` : ''}:`;
  const lines = results.slice(0, limit).map((r) => {
    const dict = r.dictionaryUri ? ` (${r.dictionaryUri.split('/').slice(-2).join('/')})` : '';
    return `• ${r.code || r.name || '?'}${r.name && r.code !== r.name ? ` — ${r.name}` : ''}${dict}\n  uri: ${r.uri}${r.definition ? `\n  ${r.definition.slice(0, 220)}` : ''}`;
  });
  return [head, ...lines].join('\n');
}

function summarizeProperty(p: BsddClassProperty): string {
  const tail: string[] = [];
  if (p.dataType) tail.push(`type=${p.dataType}`);
  if (p.allowedValues && p.allowedValues.length > 0) {
    const values = p.allowedValues.slice(0, 6).map((v) => v.value).join(', ');
    tail.push(`allowed=[${values}${p.allowedValues.length > 6 ? `, …+${p.allowedValues.length - 6}` : ''}]`);
  }
  if (p.units && p.units.length > 0) tail.push(`units=[${p.units.join(', ')}]`);
  return `${p.name}${tail.length > 0 ? ` (${tail.join(', ')})` : ''}`;
}

function summarizeClassInfo(info: BsddClassInfo, propsLimit = 40): string {
  // Group properties by Pset for a more useful overview.
  const byPset = new Map<string, BsddClassProperty[]>();
  for (const p of info.classProperties) {
    const key = p.propertySet ?? '(no Pset)';
    const list = byPset.get(key) ?? [];
    list.push(p);
    byPset.set(key, list);
  }
  const head = [
    `bSDD class ${info.code}${info.name && info.name !== info.code ? ` — ${info.name}` : ''}`,
    `  uri: ${info.uri}`,
  ];
  if (info.parentClassUri) head.push(`  parent: ${info.parentClassUri}`);
  if (info.relatedIfcEntityNames && info.relatedIfcEntityNames.length > 0) {
    head.push(`  related IFC: ${info.relatedIfcEntityNames.join(', ')}`);
  }
  if (info.definition) head.push(`  definition: ${info.definition.slice(0, 400)}`);
  head.push(`  ${info.classProperties.length} properties across ${byPset.size} Pset(s):`);

  const blocks: string[] = [...head];
  let printed = 0;
  for (const [psetName, props] of byPset) {
    blocks.push(`  • ${psetName} (${props.length}):`);
    for (const p of props) {
      if (printed >= propsLimit) {
        blocks.push(`    … +${info.classProperties.length - printed} more`);
        return blocks.join('\n');
      }
      blocks.push(`    - ${summarizeProperty(p)}`);
      printed++;
    }
  }
  return blocks.join('\n');
}

function summarizePropertySets(ifcType: string, sets: Array<{ name: string; properties: BsddClassProperty[] }>): string {
  if (sets.length === 0) return `bSDD has no property sets registered for ${ifcType}.`;
  const head = `bSDD property sets for ${ifcType} — ${sets.length} Pset(s):`;
  const lines: string[] = [head];
  for (const set of sets) {
    lines.push(`• ${set.name} (${set.properties.length} properties):`);
    for (const p of set.properties.slice(0, 8)) lines.push(`  - ${summarizeProperty(p)}`);
    if (set.properties.length > 8) lines.push(`  - … +${set.properties.length - 8} more`);
  }
  return lines.join('\n');
}

function summarizeMatchCandidates(ifcType: string, candidates: BsddSearchResult[]): string {
  if (candidates.length === 0) return `No bSDD candidates for ${ifcType}.`;
  const head = `${candidates.length} bSDD candidate(s) for ${ifcType}:`;
  const lines = candidates.slice(0, 25).map((c) =>
    `• ${c.code || c.name || '?'}${c.name && c.code !== c.name ? ` — ${c.name}` : ''}\n  uri: ${c.uri}${c.definition ? `\n  ${c.definition.slice(0, 200)}` : ''}`,
  );
  return [head, ...lines].join('\n');
}

const bsddSearch: Tool = {
  name: 'bsdd_search',
  description: 'Search the buildingSMART Data Dictionary for classes by keyword.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // bSDD is a network resource — pick any loaded model just for the
    // namespace; if no models are loaded we still need a context that
    // exposes `bim.bsdd`. Synthesize a stand-in model rather than
    // failing on agents that ask before loading.
    const loaded = ctx.registry.list()[0];
    if (!loaded) {
      throw new ToolExecutionError({
        code: ToolErrorCode.MODEL_NOT_FOUND,
        message: 'Load a model first; bSDD tools share its bim namespace.',
        hint: 'Run model_load with a small IFC, or add a placeholder file via the CLI.',
      });
    }
    try {
      const query = input.query as string;
      const results = await loaded.bim.bsdd.search(query);
      return okResult(summarizeSearchResults(query, results), { query, count: results.length, results });
    } catch (err) {
      rethrowBsddError(err, 'search');
    }
  },
};

const bsddClass: Tool = {
  name: 'bsdd_class',
  description: 'Full class details for an IFC entity name (e.g. "IfcWall") from bSDD.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { ifc_type: { type: 'string' } },
    required: ['ifc_type'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const loaded = ctx.registry.list()[0];
    if (!loaded) throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: 'Load a model first.' });
    let info;
    try {
      info = await loaded.bim.bsdd.fetchClassInfo(input.ifc_type as string);
    } catch (err) {
      rethrowBsddError(err, 'class lookup');
    }
    if (!info) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `bSDD has no class for '${input.ifc_type}'.`,
      });
    }
    return okResult(summarizeClassInfo(info), info as unknown as Record<string, unknown>);
  },
};

const bsddPropertySets: Tool = {
  name: 'bsdd_property_sets',
  description: 'Get all property sets defined for an IFC entity in bSDD (e.g. Pset_WallCommon for IfcWall).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { ifc_type: { type: 'string' } },
    required: ['ifc_type'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const loaded = ctx.registry.list()[0];
    if (!loaded) throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: 'Load a model first.' });
    try {
      const ifcType = input.ifc_type as string;
      const psets = await loaded.bim.bsdd.getPropertySets(ifcType);
      const out = Array.from(psets.entries()).map(([name, props]) => ({ name, properties: props }));
      return okResult(
        summarizePropertySets(ifcType, out),
        { ifcType, count: out.length, propertySets: out },
      );
    } catch (err) {
      rethrowBsddError(err, 'property-set lookup');
    }
  },
};

const bsddMatch: Tool = {
  name: 'bsdd_match',
  description: 'Suggest matching bSDD classes for an entity in the loaded model. Useful for classifying unclassified elements.',
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
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    let expressId: number | null = null;
    if (typeof input.express_id === 'number') expressId = input.express_id;
    else if (typeof input.global_id === 'string') {
      for (const [, list] of m.store.entityIndex.byType) {
        for (const id of list) {
          const name = m.store.entities.getTypeName(id);
          if (!name) continue;
          // We need to resolve via EntityNode, but for performance we can
          // compare GlobalId from the parsed attribute path lazily.
          expressId = id;
          break;
        }
        if (expressId) break;
      }
    }
    if (expressId == null) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide express_id or global_id.' });
    }
    const ifcType = m.store.entities.getTypeName(expressId) ?? 'Unknown';
    try {
      const candidates = await m.bim.bsdd.searchRelatedClasses(ifcType);
      return okResult(
        summarizeMatchCandidates(ifcType, candidates),
        { ifcType, count: candidates.length, candidates },
      );
    } catch (err) {
      rethrowBsddError(err, 'related-class search');
    }
  },
};

export const bsddTools: Tool[] = [bsddSearch, bsddClass, bsddPropertySets, bsddMatch];
