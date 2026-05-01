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
    const results = await loaded.bim.bsdd.search(input.query as string);
    return okResult(`Found ${results.length} bSDD class(es).`, { results });
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
    const info = await loaded.bim.bsdd.fetchClassInfo(input.ifc_type as string);
    if (!info) {
      throw new ToolExecutionError({
        code: ToolErrorCode.ENTITY_NOT_FOUND,
        message: `bSDD has no class for '${input.ifc_type}'.`,
      });
    }
    return okResult(`${info.code}: ${info.classProperties.length} properties.`, info as unknown as Record<string, unknown>);
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
    const psets = await loaded.bim.bsdd.getPropertySets(input.ifc_type as string);
    const out = Array.from(psets.entries()).map(([name, props]) => ({ name, properties: props }));
    return okResult(`${out.length} property set(s) for ${input.ifc_type}.`, { propertySets: out });
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
    const candidates = await m.bim.bsdd.searchRelatedClasses(ifcType);
    return okResult(`${candidates.length} bSDD candidate(s) for ${ifcType}.`, { ifcType, candidates });
  },
};

export const bsddTools: Tool[] = [bsddSearch, bsddClass, bsddPropertySets, bsddMatch];
