/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RoomCommandConflictError, type RoomCommand } from '@ifc-lite/sdk';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import type { JsonSchema } from '../protocol/index.js';
import { okResult, resolveModel } from './util.js';
const xy = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const edit = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

/** #6232 D5: real mesh-derived native DCEL, shared occupancy/layout/writer and Undo policy. */
export const roomCommandTool: Tool = {
  name: 'room_command', scope: 'mutate',
  description: 'Native Room operations from the current tessellated wall geometry. Query candidate faces; Auto creates unoccupied rooms, Pick selects a point, Footprint encloses the storey, Update follows detected boundaries, Edit changes retained native topology and synchronizes IFC spaces. All coordinates/settings are storey-local metres. Requires the installed WASM geometry runtime. Each write is one mutation_undo operation; supported shapes and occupied-room refusals match the viewer.',
  inputSchema: {
    type: 'object', properties: {
      model_id: { type: 'string', description: 'Required with multiple models.' },
      storey_express_id: { type: 'integer', minimum: 1 },
      command: {
        type: 'object', properties: {
          action: { enum: ['query', 'auto', 'pick', 'footprint', 'update', 'edit'] }, point: xy,
          expressIds: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
          weld: { type: 'number', exclusiveMinimum: 0 }, minArea: { type: 'number', minimum: 0 },
          boundary: { enum: ['inner', 'center', 'outer'] }, height: { type: 'number', exclusiveMinimum: 0 },
          z: { type: 'number' }, namePattern: { type: 'string' }, PredefinedType: { type: 'string' }, ObjectType: { type: 'string' },
          tolerance: { type: 'number', exclusiveMinimum: 0 },
          operation: { anyOf: [
            edit({ kind: { enum: ['drag'] }, from: xy, to: xy }, ['kind', 'from', 'to']),
            edit({ kind: { enum: ['split'] }, a: xy, b: xy }, ['kind', 'a', 'b']),
            edit({ kind: { enum: ['remove'] }, at: xy }, ['kind', 'at']),
            edit({ kind: { enum: ['prune'] } }, ['kind']),
          ] },
        }, required: ['action'], additionalProperties: false,
        anyOf: [
          { properties: { action: { enum: ['query', 'auto', 'footprint'] } } },
          { properties: { action: { enum: ['pick'] } }, required: ['point'] },
          { properties: { action: { enum: ['update'] } }, required: ['expressIds'] },
          { properties: { action: { enum: ['edit'] } }, required: ['operation'] },
        ],
      },
    }, required: ['storey_express_id', 'command'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    try {
      ctx.signal.throwIfAborted();
      const result = await model.bim.store.roomCommand(model.id, input.storey_express_id as number, { ...(input.command as RoomCommand), signal: ctx.signal });
      return okResult(`Room command completed: ${result.created.length} created, ${result.updated.length} updated, ${result.deleted.length} deleted.`, { ...result });
    } catch (error) {
      if (error instanceof ToolExecutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.signal.aborted) throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message, details: { retryable: true } });
      if (error instanceof RoomCommandConflictError) throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message, details: { retryable: true } });
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
    }
  },
};

/** Thin read-only entry point over the same native Room command service. */
export const queryRoomsTool: Tool = {
  name: 'query_rooms', scope: 'read',
  description: 'Read native mesh-derived room candidates on a loaded storey. Coordinates and settings are storey-local metres. No IFC or Undo operation is written.',
  inputSchema: {
    type: 'object', properties: {
      model_id: roomCommandTool.inputSchema.properties!.model_id,
      storey_express_id: roomCommandTool.inputSchema.properties!.storey_express_id,
      settings: { type: 'object', properties: Object.fromEntries(
        ['weld', 'minArea', 'boundary'].map(name => [name, roomCommandTool.inputSchema.properties!.command.properties![name]]),
      ), additionalProperties: false },
    }, required: ['storey_express_id'], additionalProperties: false,
  },
  handler(input, ctx) {
    return roomCommandTool.handler({ ...input, command: { ...(input.settings as Record<string, unknown> | undefined), action: 'query' } }, ctx);
  },
};
