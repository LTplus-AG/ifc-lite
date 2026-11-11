/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ClassificationInStoreParams, MirrorElementsParams } from '@ifc-lite/create';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
const modelId = { type: 'string', description: 'Required when several models are loaded.' };
const ids = { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 10000 };
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
function invoke(input: Record<string, unknown>, ctx: Parameters<Tool['handler']>[1], edit: (model: ReturnType<typeof resolveModel>) => unknown) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  try { return okResult('Model updated.', { modelId: model.id, result: edit(model) }); }
  catch (error) { throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) }); }
}
export const modellingC5Tools: Tool[] = [
  {
    name: 'mirror_elements', scope: 'mutate',
    description: 'Mirror upright products about a storey-local XY axis line in metres, in place or as copies. Hosted openings stay hosted; door handedness flips. Grids are refused atomically.',
    inputSchema: { type: 'object', properties: { model_id: modelId, express_ids: ids, axis: { type: 'array', items: point, minItems: 2, maxItems: 2 }, copy: { type: 'boolean' } }, required: ['express_ids', 'axis'], additionalProperties: false },
    handler: (input, ctx) => invoke(input, ctx, model => model.bim.store.mirrorElements(model.id, input.express_ids as number[], { axis: input.axis as MirrorElementsParams['axis'], copy: input.copy as boolean | undefined })),
  },
  {
    name: 'add_classification', scope: 'mutate',
    description: 'Create or reuse an IfcClassification system and reference. Optionally associate objects with the reference, retaining their other classifications.',
    inputSchema: { type: 'object', properties: { model_id: modelId, System: { type: 'string', minLength: 1 }, Identification: { type: 'string', minLength: 1 }, Name: { type: 'string' }, Source: { type: 'string' }, Edition: { type: 'string' }, Location: { type: 'string' }, objects: ids }, required: ['System', 'Identification'], additionalProperties: false },
    handler: (input, ctx) => invoke(input, ctx, model => {
      const { model_id: _model, ...params } = input;
      return model.bim.store.addClassification(model.id, params as unknown as ClassificationInStoreParams);
    }),
  },
  {
    name: 'assign_classification', scope: 'mutate',
    description: 'Associate live objects with an existing IfcClassification or IfcClassificationReference. Extends the existing relationship without duplicates.',
    inputSchema: { type: 'object', properties: { model_id: modelId, classification_id: { type: 'integer', minimum: 1 }, objects: ids }, required: ['classification_id', 'objects'], additionalProperties: false },
    handler: (input, ctx) => invoke(input, ctx, model => model.bim.store.assignClassification(model.id, input.classification_id as number, input.objects as number[])),
  },
];
