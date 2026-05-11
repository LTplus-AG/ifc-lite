/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discovery & metadata tools (spec §7.1).
 *
 * These are the always-on, read-only tools an agent calls first to figure
 * out what models are loaded and what's in them.
 */

import {
  extractGeoreferencingOnDemand,
  extractLengthUnitScale,
  getAllAttributesForEntity,
  getEntityMetadata,
  getInheritanceChainForEntity,
  isKnownEntity,
} from '@ifc-lite/parser';
import type { Tool } from './types.js';
import { resolveModel, okResult } from './util.js';
import { loadIfcModel } from '../loader.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

export const modelInfo: Tool = {
  name: 'model_info',
  description: 'Return schema, entity counts, file metadata, georeferencing, and units for the active (or named) model.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model identifier. Optional when only one model is loaded.' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const georef = extractGeoreferencingOnDemand(m.store);
    const lengthScale = m.store.source && m.store.entityIndex
      ? extractLengthUnitScale(m.store.source, m.store.entityIndex)
      : 1.0;

    const typeCounts: Record<string, number> = {};
    for (const [type, ids] of m.store.entityIndex.byType) {
      typeCounts[type] = ids.length;
    }

    const summary = `Model '${m.name}' (${m.store.schemaVersion}): ${m.store.entityCount.toLocaleString()} entities, ${(m.store.fileSize / 1024).toFixed(1)} KB`;
    return okResult(summary, {
      id: m.id,
      name: m.name,
      schema: m.store.schemaVersion,
      entityCount: m.store.entityCount,
      fileSize: m.store.fileSize,
      filePath: m.filePath,
      loadedAt: m.loadedAt,
      lengthUnitScale: lengthScale,
      georeferencing: georef ?? null,
      typeCountsTop20: Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([type, count]) => ({ type, count })),
      typeCountsTotal: Object.keys(typeCounts).length,
    });
  },
};

export const modelList: Tool = {
  name: 'model_list',
  description: 'List all currently loaded models with metadata.',
  scope: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const list = ctx.registry.list();
    return okResult(
      list.length === 0
        ? 'No models currently loaded.'
        : `${list.length} model${list.length === 1 ? '' : 's'} loaded.`,
      {
        count: list.length,
        models: list.map((m) => ({
          id: m.id,
          name: m.name,
          schema: m.store.schemaVersion,
          entityCount: m.store.entityCount,
          fileSize: m.store.fileSize,
          filePath: m.filePath,
          loadedAt: m.loadedAt,
        })),
      },
    );
  },
};

export const modelLoad: Tool = {
  name: 'model_load',
  description: 'Load an IFC file from disk into the session. Requires `mutate` scope. The path must be inside the configured allowedPaths roots (when set).',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the .ifc file.' },
      model_id: { type: 'string', description: 'Optional explicit ID. Defaults to a slug of the file name.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const filePath = input.file_path as string;
    try {
      const loaded = await loadIfcModel(filePath, {
        modelId: input.model_id as string | undefined,
        allowedPaths: ctx.config.allowedPaths,
      });
      ctx.registry.add(loaded);
      ctx.log.log('info', 'model_load', { id: loaded.id, file: filePath, entities: loaded.store.entityCount });
      return okResult(
        `Loaded '${loaded.name}' as model '${loaded.id}' (${loaded.store.entityCount.toLocaleString()} entities).`,
        { id: loaded.id, name: loaded.name, schema: loaded.store.schemaVersion, entityCount: loaded.store.entityCount },
      );
    } catch (err) {
      throw new ToolExecutionError({
        code: ToolErrorCode.PARSE_FAILED,
        message: `Failed to load '${filePath}': ${(err as Error).message}`,
      });
    }
  },
};

export const modelUnload: Tool = {
  name: 'model_unload',
  description: 'Drop a model from session memory.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model identifier.' },
    },
    required: ['model_id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = input.model_id as string;
    if (!ctx.registry.get(id)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.MODEL_NOT_FOUND,
        message: `Model '${id}' is not loaded.`,
      });
    }
    ctx.registry.remove(id);
    return okResult(`Unloaded model '${id}'.`, { id });
  },
};

export const schemaDescribe: Tool = {
  name: 'schema_describe',
  description: 'Describe an IFC entity type: attributes, parents, inheritance chain. Useful for an agent to know the legal shape before mutating.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'IFC entity name, e.g. IfcWall.' },
      include_inherited: { type: 'boolean', default: true, description: 'Include attributes inherited from parent entities.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
  handler(input) {
    const type = input.type as string;
    if (!isKnownEntity(type)) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Unknown IFC entity type: '${type}'`,
        hint: 'Use canonical PascalCase names like IfcWall, IfcDoor.',
      });
    }
    const meta = getEntityMetadata(type);
    if (!meta) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `No schema metadata for '${type}'`,
      });
    }
    const inheritance = getInheritanceChainForEntity(type);
    const includeInherited = (input.include_inherited as boolean | undefined) ?? true;
    const attrs = includeInherited ? getAllAttributesForEntity(type) : meta.attributes;
    return okResult(
      `${type}: ${attrs.length} attributes, parent ${meta.parent ?? '(root)'}, abstract=${meta.isAbstract}.`,
      {
        type: meta.name,
        parent: meta.parent ?? null,
        isAbstract: meta.isAbstract,
        inheritanceChain: inheritance,
        attributes: attrs,
      },
    );
  },
};

export const discoveryTools: Tool[] = [
  modelInfo,
  modelList,
  modelLoad,
  modelUnload,
  schemaDescribe,
];
