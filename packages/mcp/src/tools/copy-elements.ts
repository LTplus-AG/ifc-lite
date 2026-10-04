/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CopyTransform, CopyArrayParams } from '@ifc-lite/create';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

const point2 = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const selection = {
  model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
  express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 10000 },
};

/** #6232 D5: paste, Duplicate and array share dependency selection, placement and atomic copy. */
export const copyElementsTools: Tool[] = [
  {
    name: 'duplicate_element', scope: 'mutate',
    description: 'Duplicate one product with its hosted openings/fillings and assembly parts, new GlobalIds and the viewer Name suffix (copy). Supply the desired storey-local IFC XYZ metre offset; optional Name overrides the suffix. One mutation_undo removes the whole duplicate.',
    inputSchema: {
      type: 'object', properties: {
        model_id: selection.model_id, express_id: { type: 'integer', minimum: 1 },
        offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        Name: { type: 'string' },
      }, required: ['express_id', 'offset'], additionalProperties: false,
    },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      try {
        const entity = model.bim.store.duplicateElement({ modelId: model.id, expressId: input.express_id as number },
          { offset: input.offset as [number, number, number], Name: input.Name as string | undefined });
        return okResult('Duplicated product.', { modelId: model.id, entity });
      } catch (error) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
      }
    },
  },
  {
    name: 'copy_elements', scope: 'mutate',
    description: 'Copy selected products once per transform, with their hosted openings/fillings and assembly parts. Selected children are deduplicated. Offset is storey-local IFC XYZ metres; turn is radians about pivot XY. One mutation_undo removes the complete batch.',
    inputSchema: {
      type: 'object', properties: { ...selection, transforms: {
        type: 'array', minItems: 1, maxItems: 10000, items: {
          type: 'object', properties: {
            offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            pivot: point2, turn: { type: 'number' }, targetStoreyId: { type: 'integer', minimum: 1 },
          }, additionalProperties: false,
        },
      } }, required: ['express_ids', 'transforms'], additionalProperties: false,
    },
    handler(input, ctx) { return copy(input, ctx, false); },
  },
  {
    name: 'array_elements', scope: 'mutate',
    description: 'Linear spacing/fit or polar array using the viewer planner. Count includes the original; a full circle excludes the coincident final copy. Distances and anchor/cursor are storey-local metres; angleDegrees is degrees. One mutation_undo removes all copies.',
    inputSchema: {
      type: 'object', properties: { ...selection, params: {
        type: 'object', properties: {
          mode: { type: 'string', enum: ['linear', 'polar'] }, count: { type: 'integer', minimum: 2, maximum: 10001 },
          anchor: point2, cursor: point2, distance: { type: 'number', exclusiveMinimum: 0 }, fit: { type: 'boolean' },
          angleDegrees: { type: 'number', minimum: -360, maximum: 360 },
        }, required: ['mode', 'count', 'anchor'], additionalProperties: false,
      } }, required: ['express_ids', 'params'], additionalProperties: false,
    },
    handler(input, ctx) { return copy(input, ctx, true); },
  },
];

function copy(input: Record<string, unknown>, ctx: Parameters<Tool['handler']>[1], array: boolean) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  try {
    const ids = input.express_ids as number[];
    const refs = array ? model.bim.store.arrayElements(model.id, ids, input.params as CopyArrayParams)
      : model.bim.store.copyElements(model.id, ids, input.transforms as CopyTransform[]);
    return okResult(`Copied ${refs.length} selected products.`, { modelId: model.id, entities: refs });
  } catch (error) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
  }
}
