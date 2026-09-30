/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: thin tool over the canonical SDK/store wall-join operation. */
import type { WallJoinApplyOptions } from '@ifc-lite/create';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

export const joinWallsTool: Tool = {
  name: 'join_walls',
  description: 'Join two straight walls in the same placement frame through IfcRelConnectsPathElements. Uses the Model workspace and SDK core, rewrites bodies and axes atomically, and refuses unreadable or stranded hosted openings. One mutation_undo restores the earlier complete graph.',
  scope: 'mutate',
  inputSchema: {
    type: 'object', properties: {
      model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
      a_express_id: { type: 'integer', minimum: 1 }, b_express_id: { type: 'integer', minimum: 1 },
      options: {
        type: 'object', properties: {
          Name: { type: 'string' },
          tolerance: { type: 'number', minimum: 0, description: 'Maximum distance from an axis end to the crossing, in metres.' },
          priority: { type: 'string', enum: ['a', 'b'], description: 'Wall that runs through an L or butt join.' },
          priorities: { type: 'object', properties: {
            a: { type: 'array', items: { type: 'integer' } }, b: { type: 'array', items: { type: 'integer' } },
          }, additionalProperties: false },
        }, additionalProperties: false,
      },
    }, required: ['a_express_id', 'b_express_id'], additionalProperties: false,
  },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    try {
      const relationship = model.bim.store.joinWalls(model.id, input.a_express_id as number, input.b_express_id as number, input.options as WallJoinApplyOptions | undefined);
      return okResult(`Joined walls through IfcRelConnectsPathElements #${relationship.expressId}.`, {
        ...relationship, type: 'IfcRelConnectsPathElements', walls: [input.a_express_id, input.b_express_id],
      });
    } catch (error) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
    }
  },
};
