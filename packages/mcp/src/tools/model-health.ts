/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { readPackageVersion } from '@ifc-lite/data/node';
import { filterWorstHosts, readGeometryDiagnostics } from '@ifc-lite/export';
import { computeModelStats, foldedEntityCount, overlayFromView } from '@ifc-lite/sdk/headless';
import { loadDeliveryRecipe, runDeliveryRecipe } from '@ifc-lite/sdk/headless/delivery';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import { withIfcBytes } from './export-source.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const modelStats: Tool = {
  name: 'model_stats',
  title: 'Model statistics',
  description: 'Model health and quantities: element counts, floor area, wall and window area, materials, unnamed elements and duplicate GlobalIds.',
  scope: 'read',
  annotations: readAnnotations,
  inputSchema: {
    type: 'object',
    properties: { model_id: { type: 'string', description: 'Loaded model ID. Defaults to the active model.' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      building: { type: 'string' }, schema: { type: 'string' }, entityCount: { type: 'integer' },
      storeys: { type: 'array', items: { type: 'string' } }, storeyCount: { type: 'integer' },
      elements: { type: 'object' }, totalElements: { type: 'integer' }, quantities: { type: 'object' },
      materials: { type: 'array', items: { type: 'object' } }, validation: { type: 'object' },
    },
  },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    const count = foldedEntityCount(model.store, overlayFromView(model.backend.getMutationView(), model.store));
    const stats = computeModelStats(model.bim, model.store, count);
    return okResult(`${stats.building}: ${stats.entityCount} entities, ${stats.storeyCount} storeys, ${stats.totalElements} building elements.`, stats);
  },
};

const diagnoseGeometry: Tool = {
  name: 'model_diagnose_geometry',
  title: 'Diagnose model geometry',
  description: 'Geometry diagnostics for a loaded STEP model, including CSG failures, openings and affected hosts. Filters narrow the host list and retain model totals.',
  scope: 'read',
  annotations: readAnnotations,
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Loaded model ID. Defaults to the active model.' },
      global_id: { type: 'string', description: 'Show hosts for this IFC GlobalId.' },
      express_id: { type: 'integer', minimum: 1, description: 'Show hosts for this source express ID.' },
      type: { type: 'string', description: 'Show hosts of this IFC type, for example IfcWall.' },
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { diagnostics: { type: 'object' } } },
  async handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    if (model.store.schemaVersion === 'IFC5') {
      throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'Geometry diagnostics require a STEP model.' });
    }
    if (input.global_id != null && input.express_id != null) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide global_id or express_id.' });
    }
    if (model.backend.hasPendingChanges()) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Save and load the edited model before running source geometry diagnostics.' });
    }
    let productId = input.express_id as number | undefined;
    if (typeof input.global_id === 'string') {
      productId = model.store.entities.getExpressIdByGlobalId(input.global_id);
      if (productId === -1) {
        throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Unknown GlobalId '${input.global_id}'.` });
      }
    }
    const diagnostics = await withIfcBytes(model, readGeometryDiagnostics);
    if (!diagnostics) {
      throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'The geometry engine returned no diagnostics for this model.' });
    }
    const worstHosts = filterWorstHosts(diagnostics.worstHosts, { productId, ifcType: input.type as string | undefined });
    return okResult(`Geometry diagnostics for ${model.name}. ${worstHosts.length} matching entries in the bounded worst-host list.`,
      { diagnostics: { ...diagnostics, worstHosts } });
  },
};

const delivery: Tool = {
  name: 'model_delivery',
  title: 'Run delivery recipe',
  description: 'Delivery check from a saved JSON recipe. Run structural, IDS and information-rule checks and return the combined report.',
  scope: 'validate',
  annotations: readAnnotations,
  inputSchema: {
    type: 'object',
    properties: { recipe_path: { type: 'string', description: 'Delivery recipe JSON path. Its model, IDS and rule inputs must also be in the allowed paths.' } },
    required: ['recipe_path'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { report: { type: 'object' } } },
  async handler(input, ctx) {
    const recipePath = await resolveSafePath(input.recipe_path, ctx, 'read');
    let recipe;
    try {
      recipe = await loadDeliveryRecipe(recipePath);
    } catch (error) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
    }
    // Resolve every secondary input before opening one. A recipe is input
    // data and cannot grant permission to read additional files.
    for (const paths of [recipe.resolvedModels, recipe.resolvedIds, recipe.resolvedRules]) {
      for (const [index, path] of paths.entries()) {
        ctx.signal.throwIfAborted();
        paths[index] = await resolveSafePath(path, ctx, 'read');
      }
    }
    const version = readPackageVersion(fileURLToPath(new URL('../../package.json', import.meta.url)));
    const report = await runDeliveryRecipe(recipe, version);
    return okResult(`Delivery verdict: ${report.verdict} across ${report.models.length} model(s).`, { report });
  },
};

export const modelHealthTools = [modelStats, diagnoseGeometry, delivery];
