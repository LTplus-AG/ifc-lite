/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ElementSplitRequest, ElementTransformInput, ElementTrimExtendParams } from '@ifc-lite/create';
import type { PhysicalSizePatch } from '@ifc-lite/sdk';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import type { JsonSchema } from '../protocol/index.js';
import { okResult, resolveModel } from './util.js';

const xy = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const xyz = { ...xy, minItems: 3, maxItems: 3 };
const id = { type: 'integer', minimum: 1 };
const positive = { type: 'number', exclusiveMinimum: 0 };
const variant = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

/** #6232 D5: commands plan and write through the viewer's canonical physical cores. */
export const physicalEditTool: Tool = {
  name: 'edit_element_geometry', scope: 'mutate',
  description: 'Move/rotate a selection, change extrusion/profile dimensions, move wall endpoints, split a selection or trim/extend an axis. Coordinates are IFC storey-local metres; rotation is radians. Supported-source predicates, hosted cuts, wall joins, identity policy and atomic refusals match the viewer. One mutation_undo restores the whole operation. Shared writable source geometry is refused when editing it would alter an unrelated occurrence.',
  inputSchema: {
    type: 'object', properties: {
      model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
      operation: { anyOf: [
        variant({ kind: { enum: ['transform'] }, express_ids: { type: 'array', items: id, minItems: 1, maxItems: 10000 }, transform: { anyOf: [
          variant({ kind: { enum: ['move'] }, delta: xy }, ['kind', 'delta']),
          variant({ kind: { enum: ['rotate'] }, pivot: xy, angle: { type: 'number' } }, ['kind', 'pivot', 'angle']),
        ] } }, ['kind', 'express_ids', 'transform']),
        variant({ kind: { enum: ['size'] }, express_id: id, patch: { anyOf: [
          variant({ kind: { enum: ['wall'] }, Height: positive, Thickness: positive }, ['kind']),
          variant({ kind: { enum: ['slab'] }, Thickness: positive }, ['kind', 'Thickness']),
          variant({ kind: { enum: ['linear'] }, Depth: positive, XDim: positive, YDim: positive, fixed: { enum: ['start', 'end'] } }, ['kind']),
        ] } }, ['kind', 'express_id', 'patch']),
        variant({ kind: { enum: ['wall_endpoints'] }, express_id: id, start: xyz, end: xyz, moveJoinedEnds: { type: 'boolean', default: true } }, ['kind', 'express_id', 'start', 'end']),
        variant({ kind: { enum: ['split'] }, requests: { type: 'array', minItems: 1, maxItems: 10000, items: variant({ expressId: id, cut: { anyOf: [
          variant({ kind: { enum: ['wall', 'linear'] }, distance: positive }, ['kind', 'distance']),
          variant({ kind: { enum: ['slab'] }, a: xy, b: xy }, ['kind', 'a', 'b']),
        ] } }, ['expressId', 'cut']) } }, ['kind', 'requests']),
        variant({ kind: { enum: ['trim_extend'] }, express_id: id, params: variant({ mode: { enum: ['trim', 'extend'] }, click: xy, boundary: { anyOf: [
          variant({ wallId: id }, ['wallId']),
          variant({ a: xy, b: xy, tMin: { type: 'number' }, tMax: { type: 'number' }, reach: { type: 'number', minimum: 0 } }, ['a', 'b', 'tMin', 'tMax', 'reach']),
        ] } }, ['mode', 'click', 'boundary']) }, ['kind', 'express_id', 'params']),
      ] },
    }, required: ['operation'], additionalProperties: false,
  },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    const op = input.operation as Record<string, unknown>;
    const ref = { modelId: model.id, expressId: op.express_id as number };
    try {
      let result: unknown;
      switch (op.kind) {
        case 'transform': result = model.bim.store.transformElements(model.id, op.express_ids as number[], op.transform as ElementTransformInput['op']); break;
        case 'size': result = model.bim.store.setElementSize(ref, op.patch as PhysicalSizePatch); break;
        case 'wall_endpoints': result = model.bim.store.resizeWall(ref, op.start as [number, number, number], op.end as [number, number, number], { moveJoinedEnds: op.moveJoinedEnds !== false }); break;
        case 'split': result = model.bim.store.splitElements(model.id, op.requests as ElementSplitRequest[]); break;
        case 'trim_extend': result = model.bim.store.trimExtendElement(ref, op.params as ElementTrimExtendParams); break;
        default: throw new Error('Unsupported physical operation');
      }
      return okResult(`Completed ${String(op.kind)}.`, { modelId: model.id, entities: result });
    } catch (error) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
    }
  },
};
