/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Creation-only commands over the same builders as the Model workspace (#6232 D5). */
import type { ColumnInStoreParams, ProfiledColumnInStoreParams, CurtainWallInStoreParams, GridInStoreParams, GridColumnBinding } from '@ifc-lite/create';
import type { JsonSchema } from '../protocol/index.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

const point = (dimensions: number): JsonSchema => ({ type: 'array', items: { type: 'number' }, minItems: dimensions, maxItems: dimensions });
const metadata: Record<string, JsonSchema> = {
  Name: { type: 'string' }, Description: { type: 'string' }, ObjectType: { type: 'string' },
  GlobalId: { type: 'string', minLength: 22, maxLength: 22 },
};
const profile: JsonSchema = { type: 'object', description: 'Canonical ProfileSection, e.g. {Type:"Rectangle",XDim:0.05,YDim:0.15}. The shared profile builder validates the section.' };
const gridSpec: JsonSchema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'number' } }] };
const axis: JsonSchema = {
  type: 'object', properties: { Tag: { type: 'string' }, Start: point(2), End: point(2) },
  required: ['Tag', 'Start', 'End'], additionalProperties: false,
};
const axes: JsonSchema = { type: 'array', items: axis, minItems: 1 };
const schemas: Record<'curtain_wall' | 'grid' | 'grid_column', JsonSchema> = {
  curtain_wall: {
    type: 'object', properties: {
      ...metadata, Tag: { type: 'string' }, Start: point(3), End: point(3), Height: { type: 'number', minimum: 0 },
      UGrid: gridSpec, VGrid: gridSpec, MullionProfile: profile, TransomProfile: profile,
      PanelThickness: { type: 'number', minimum: 0 }, EdgeMembers: { type: 'boolean' },
      PredefinedType: { type: 'string', enum: ['USERDEFINED', 'NOTDEFINED'] },
    }, required: ['Start', 'End', 'Height'], additionalProperties: false,
  },
  grid: {
    type: 'object', properties: {
      ...metadata, Position: point(3), Direction: { type: 'number' }, UAxes: axes, VAxes: axes, WAxes: axes,
      PredefinedType: { type: 'string', enum: ['RECTANGULAR', 'RADIAL', 'TRIANGULAR', 'IRREGULAR', 'USERDEFINED', 'NOTDEFINED'] },
    }, required: ['UAxes', 'VAxes'], additionalProperties: false,
  },
  grid_column: {
    type: 'object', properties: {
      ...metadata, Tag: { type: 'string' }, Position: point(3), RefDirection: point(3),
      Height: { type: 'number', minimum: 0 }, Width: { type: 'number', minimum: 0 }, Depth: { type: 'number', minimum: 0 },
      Profile: profile,
    }, required: ['Position', 'Height'], additionalProperties: false,
    anyOf: [{ required: ['Profile'] }, { required: ['Width', 'Depth'] }],
  },
};

function designTool(kind: keyof typeof schemas): Tool {
  const type = kind === 'curtain_wall' ? 'IfcCurtainWall' : kind === 'grid' ? 'IfcGrid' : 'IfcColumn';
  return {
    name: `place_${kind}`,
    description: `Create ${type} on a loaded storey through the Model workspace/SDK builder. `
      + 'All lengths are metres in the storey frame; grid axes are in the grid frame. '
      + 'Grid columns require actual model-local grid/axis references and a position matching their live crossing. '
      + 'Creates the complete graph atomically; one mutation_undo removes it. This command creates a new element on each call.',
    scope: 'mutate',
    inputSchema: {
      type: 'object', properties: {
        model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
        storey_express_id: { type: 'integer', minimum: 1 }, params: schemas[kind],
        ...(kind === 'grid_column' ? { binding: {
          type: 'object', properties: { GridId: { type: 'integer', minimum: 1 }, IntersectingAxes: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 } },
          required: ['GridId', 'IntersectingAxes'], additionalProperties: false,
        } satisfies JsonSchema } : {}),
      }, required: ['storey_express_id', 'params', ...(kind === 'grid_column' ? ['binding'] : [])], additionalProperties: false,
    },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      const storey = input.storey_express_id as number;
      try {
        const ref = kind === 'curtain_wall'
          ? model.bim.store.addCurtainWall(model.id, storey, input.params as CurtainWallInStoreParams)
          : kind === 'grid'
            ? model.bim.store.addGrid(model.id, storey, input.params as GridInStoreParams)
            : model.bim.store.addColumnOnGrid(model.id, storey, input.params as ColumnInStoreParams | ProfiledColumnInStoreParams, input.binding as GridColumnBinding);
        return okResult(`Placed ${type} as #${ref.expressId}.`, { ...ref, type });
      } catch (error) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export const designPlaceTools: Tool[] = [designTool('curtain_wall'), designTool('grid'), designTool('grid_column')];
