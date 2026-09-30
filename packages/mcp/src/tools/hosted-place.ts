/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** MCP gesture-free counterparts of the viewer's hosted commands (#6232 D5).
 * All IFC writing and fit/overlap refusal is in @ifc-lite/create via bim.store. */
import { readHostedFill, type HostedDoorInStoreParams, type HostedWindowInStoreParams, type WallOpeningInStoreParams } from '@ifc-lite/create';
import type { JsonSchema } from '../protocol/index.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { okResult, resolveModel } from './util.js';
import type { Tool } from './types.js';

const common: Record<string, JsonSchema> = {
  Offset: { type: 'number', description: 'Opening centre along the host local X, in metres.' },
  Sill: { type: 'number', description: 'Bottom above the host local origin, in metres; defaults to zero for a door or opening.' },
  Width: { type: 'number', minimum: 0 }, Height: { type: 'number', minimum: 0 },
  CutDepth: { type: 'number', minimum: 0 },
  Name: { type: 'string' }, Description: { type: 'string' }, ObjectType: { type: 'string' }, Tag: { type: 'string' },
  GlobalId: { type: 'string', minLength: 22, maxLength: 22 },
};

function hostedTool(kind: 'opening' | 'door' | 'window'): Tool {
  const type = kind === 'opening' ? 'IfcOpeningElement' : kind === 'door' ? 'IfcDoor' : 'IfcWindow';
  const fill: Record<string, JsonSchema> = kind === 'opening' ? {} : {
    FrameThickness: { type: 'number', minimum: 0 },
    PredefinedType: { type: 'string', enum: kind === 'door'
      ? ['DOOR', 'GATE', 'TRAPDOOR', 'USERDEFINED', 'NOTDEFINED']
      : ['WINDOW', 'SKYLIGHT', 'LIGHTDOME', 'USERDEFINED', 'NOTDEFINED'] },
    ...(kind === 'door'
      ? { OperationType: { type: 'string' }, UserDefinedOperationType: { type: 'string' } }
      : { PartitioningType: { type: 'string' }, UserDefinedPartitioningType: { type: 'string' } }),
  };
  return {
    name: `place_${kind}`,
    description: `Place ${type} in a loaded wall through the same creation core as the Model workspace and SDK. `
      + 'Dimensions are metres in the host frame. Refuses cuts outside the wall, overlapping cuts, and unreadable opening geometry. '
      + 'Writes the complete void/fill graph atomically; one mutation_undo removes the placement.',
    scope: 'mutate',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
        host_express_id: { type: 'integer', minimum: 1, description: 'IfcWall express id within the chosen model, including a wall created this session.' },
        params: { type: 'object', properties: { ...common, ...fill }, required: ['Offset', 'Width', 'Height', ...(kind === 'window' ? ['Sill'] : [])], additionalProperties: false },
      },
      required: ['host_express_id', 'params'], additionalProperties: false,
    },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      const hostId = input.host_express_id as number;
      const params = input.params as WallOpeningInStoreParams;
      try {
        const placed = kind === 'opening' ? model.bim.store.addOpening(model.id, hostId, params)
          : kind === 'door' ? model.bim.store.addHostedDoor(model.id, hostId, params as HostedDoorInStoreParams)
          : model.bim.store.addHostedWindow(model.id, hostId, params as HostedWindowInStoreParams);
        const hosted = readHostedFill(model.store, placed.expressId, model.backend.getMutationView());
        return okResult(`Placed ${type} as #${placed.expressId} in wall #${hostId}.`, {
          ...placed, type, openingId: hosted?.openingId ?? placed.expressId, hostExpressId: hostId,
        });
      } catch (error) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export const hostedPlaceTools: Tool[] = (['opening', 'door', 'window'] as const).map(hostedTool);
